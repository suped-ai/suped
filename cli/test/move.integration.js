// Does a workspace actually move? Nothing else answers that. `sync` has unit
// tests over its manifest and no end-to-end coverage at all, so the one thing
// the feature promises is the one thing that was never exercised.
//
// This builds a workspace, saves it, and rebuilds it as a second, entirely
// separate workspace on the same host -- which is the same operation as moving
// to another machine, minus the machine. Credentials are deliberately not part
// of it: the manifest carries none, and CI holds no accounts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/suped.js', import.meta.url));
// Two workspaces derived from one pair of names, so a developer can point this
// somewhere else the same way the other integration check allows.
const baseContainer = process.env.SUPED_CONTAINER || 'suped-ci-move';
const baseVolume = process.env.SUPED_VOLUME || 'suped-ci-move-home';
const source = { container: `${baseContainer}-a`, volume: `${baseVolume}-a` };
const target = { container: `${baseContainer}-b`, volume: `${baseVolume}-b` };

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}
assert.ok(process.env.SUPED_IMAGE, 'set SUPED_IMAGE to a built test image');
assert.equal(docker(['version']).status, 0, 'Docker must be running');
for (const { container, volume } of [source, target]) {
  // The same guard the other integration check uses: never touch a real workspace.
  assert.match(container, /^suped-(ci|verify)(-|$)/);
  assert.match(volume, /^suped-(ci|verify)(-|$)/);
  assert.notEqual(docker(['container', 'inspect', container]).status, 0, `${container} already exists`);
  assert.notEqual(docker(['volume', 'inspect', volume]).status, 0, `${volume} already exists`);
}

/** Which workspace the next commands address. This is what "another machine" means here. */
function use({ container, volume }) {
  process.env.SUPED_CONTAINER = container;
  process.env.SUPED_VOLUME = volume;
}

function cli(args, { expected = 0, timeout = 15 * 60 * 1000 } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', env: process.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

const sh = (script) => cli(['exec', 'bash', '-lc', script]);

// Origins live on the host and are mounted into both workspaces at the same
// path, so a remote recorded in one is reachable from the other. That is what a
// real remote is: an address both machines can resolve.
const remotesDir = mkdtempSync(join(tmpdir(), 'suped-move-remotes-'));
const fileDir = mkdtempSync(join(tmpdir(), 'suped-move-file-'));
for (const dir of [remotesDir, fileDir]) chmodSync(dir, 0o777);
const manifestFile = join(fileDir, 'workspace.json');
const mount = `${remotesDir}:/home/suped/remotes`;

try {
  use(source);
  cli(['-p', '127.0.0.1::3000', '-v', mount, 'up']);

  // One repository per carried root, to prove notes/ travels on the same terms
  // as projects/ rather than through some separate mechanism.
  for (const [root, name] of [['projects', 'demo'], ['notes', 'vault']]) {
    sh(`set -e
      git init --bare -q ~/remotes/${name}.git
      git clone -q ~/remotes/${name}.git ~/${root}/${name}
      cd ~/${root}/${name}
      # Cloning an empty repository leaves an unborn branch named by the
      # container's init.defaultBranch, so name it rather than assume it.
      git checkout -q -b main
      printf '%s\\n' 'carried by ${root}' > content.txt
      git add content.txt
      git -c user.name=suped -c user.email=suped@example.invalid commit -q -m 'content'
      git push -q -u origin main`);
  }
  // Something in a root that is documented as staying put, to prove it does.
  sh("printf 'local only\\n' > ~/scratch/local.txt");
  console.log('PASS source workspace with a project, a notes repository, and local-only scratch');

  cli(['sync', 'save', manifestFile]);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert.deepEqual(manifest.projects.map((p) => p.path).sort(), ['notes/vault', 'projects/demo']);
  for (const project of manifest.projects) {
    assert.ok(project.remote, `${project.path} must record a remote`);
    assert.equal(project.branch, 'main');
  }
  assert.ok(manifest.mounts.some((m) => m.includes('/home/suped/remotes')), 'mounts are recorded');
  assert.ok(manifest.ports.length, 'ports are recorded');
  // The file is meant to be committable. It must never carry a credential.
  assert.doesNotMatch(JSON.stringify(manifest), /token|password|secret|BEGIN [A-Z ]*PRIVATE KEY/i);
  console.log('PASS manifest records both roots, ports and mounts, and no credentials');

  // Another machine: a workspace that has never seen any of this.
  use(target);
  cli(['-v', mount, 'up']);
  sh('test ! -e ~/projects/demo && test ! -e ~/notes/vault');
  const restored = cli(['sync', 'restore', manifestFile]);

  for (const [root, name] of [['projects', 'demo'], ['notes', 'vault']]) {
    sh(`test -d ~/${root}/${name}/.git`);
    assert.equal(sh(`cat ~/${root}/${name}/content.txt`), `carried by ${root}\n`);
  }
  // Nothing outside the carried roots comes across, which is the other half of
  // the promise: scratch/ is where you can be sure things stay behind.
  sh('test ! -e ~/scratch/local.txt');
  // Ports and mounts are applied at creation, so restore reports them instead
  // of pretending it changed a running container.
  assert.match(restored, /suped reset .*-p .*3000/);
  console.log('PASS projects and notes cloned on the other side, scratch left behind');

  // Restoring twice must not fail or duplicate: with git-backed state coming,
  // people will run this against a workspace that is already mostly right.
  const again = cli(['sync', 'restore', manifestFile]);
  assert.match(again, /already here/);
  for (const [root, name] of [['projects', 'demo'], ['notes', 'vault']]) {
    assert.equal(sh(`cat ~/${root}/${name}/content.txt`), `carried by ${root}\n`);
  }
  console.log('PASS restore is idempotent and never overwrites what is already there');

  // The composite command, which is what a person is actually told to run. CI
  // holds no accounts, so this is the base-workspace path: a complete move
  // that carries no credentials, which must be stated rather than implied.
  use(source);
  const moveDir = join(fileDir, 'moved');
  const saved = cli(['move', 'save', moveDir]);
  assert.match(saved, /No credentials were sealed/);
  assert.ok(existsSync(join(moveDir, 'workspace.json')), 'move save writes the manifest');
  assert.equal(existsSync(join(moveDir, 'secrets.age')), false, 'nothing sealed means no sealed file');
  // The manifest half must be byte-identical to what `sync save` produces: the
  // composite is a convenience over the same files, not a second format.
  assert.deepEqual(JSON.parse(readFileSync(join(moveDir, 'workspace.json'), 'utf8')), manifest);

  use(target);
  const moved = cli(['move', 'restore', moveDir]);
  assert.match(moved, /no credentials came across/);
  assert.match(moved, /already here/);
  console.log('PASS move save/restore carries the same files, and says what it could not carry');

  // Shared state: the premise of 0.6.0. One machine gains what another one
  // did, through a git repository, without anybody carrying a file by hand.
  use(source);
  sh('git init --bare -q ~/remotes/state.git');
  cli(['state', 'init', '/home/suped/remotes/state.git']);

  // Something new happens here, after the other machine was already set up.
  sh(`set -e
    git init --bare -q ~/remotes/late.git
    git clone -q ~/remotes/late.git ~/projects/late
    cd ~/projects/late
    git checkout -q -b main
    printf '%s\\n' 'made after the other machine existed' > content.txt
    git add content.txt
    git -c user.name=suped -c user.email=suped@example.invalid commit -q -m 'late'
    git push -q -u origin main`);
  const recorded = cli(['state', 'sync']);
  assert.match(recorded, /Recorded this machine's state|Pushed to/);

  // The other machine adopts the shared state and converges on it.
  use(target);
  sh('test ! -e ~/projects/late');
  const adopted = cli(['state', 'init', '/home/suped/remotes/state.git']);
  assert.match(adopted, /Adopted the shared state/);
  assert.match(adopted, /projects\/late/);
  assert.equal(sh('cat ~/projects/late/content.txt'), 'made after the other machine existed\n');

  // And now both sides agree, without anything left to do.
  const settled = cli(['state', 'sync']);
  assert.match(settled, /already matches the shared state/);
  const shown = cli(['state']);
  assert.match(shown, /In step with the shared state/);
  console.log('PASS one machine gained what another did, through shared state');

  // Work in progress. The half of a move that was always left behind: a dirty
  // tree, a deletion, an untracked file, and a commit that is on no remote.
  use(source);
  sh(`set -e
    git init --bare -q ~/remotes/wip.git
    git clone -q ~/remotes/wip.git ~/projects/wip
    cd ~/projects/wip
    git checkout -q -b main
    printf 'original\\n' > kept.txt
    printf 'doomed\\n' > doomed.txt
    git add -A
    git -c user.name=suped -c user.email=suped@example.invalid commit -q -m base
    git push -q -u origin main
    printf 'committed but never pushed\\n' >> kept.txt
    git add -A
    git -c user.name=suped -c user.email=suped@example.invalid commit -q -m unpushed
    printf 'not committed at all\\n' >> kept.txt
    rm doomed.txt
    printf 'brand new\\n' > untracked.txt`);
  const before = sh('cd ~/projects/wip && git rev-parse HEAD && git status --porcelain | sort');

  const workDir = join(fileDir, 'with-work');
  const carried = cli(['move', 'save', workDir]);
  assert.match(carried, /Work in progress is coming with you/);
  assert.match(carried, /projects\/wip/);
  // Carrying must not disturb the repository it carried.
  assert.equal(sh('cd ~/projects/wip && git rev-parse HEAD && git status --porcelain | sort'), before,
    'the source repository is exactly as it was');
  assert.equal(sh('cd ~/projects/wip && git stash list | wc -l').trim(), '0', 'no stash was used');

  use(target);
  sh('test ! -e ~/projects/wip');
  const back = cli(['move', 'restore', workDir]);
  assert.match(back, /restored uncommitted changes in ~\/projects\/wip/);
  assert.equal(sh('cat ~/projects/wip/kept.txt'), 'original\ncommitted but never pushed\nnot committed at all\n');
  sh('test ! -e ~/projects/wip/doomed.txt');
  assert.equal(sh('cat ~/projects/wip/untracked.txt'), 'brand new\n');
  // The unpushed commit came too, and the changes are changes, not history.
  assert.match(sh('cd ~/projects/wip && git log --oneline -1'), /unpushed/);
  assert.ok(sh('cd ~/projects/wip && git status --porcelain').trim().length, 'the work arrives uncommitted');
  console.log('PASS work in progress travelled: a dirty tree, a deletion, an untracked file, and an unpushed commit');
} finally {
  // The bare repositories were created by the container's user, which is not
  // the user running this, so the host cannot unlink them. Delete them from
  // inside a workspace that still exists, where the owner is.
  for (const workspace of [source, target]) {
    use(workspace);
    if (docker(['container', 'inspect', workspace.container]).status !== 0) continue;
    spawnSync(process.execPath, [bin, 'exec', 'bash', '-lc', 'find ~/remotes -mindepth 1 -delete 2>/dev/null || true'],
      { encoding: 'utf8', env: process.env, windowsHide: true });
    break;
  }
  for (const workspace of [source, target]) {
    use(workspace);
    if (docker(['container', 'inspect', workspace.container]).status === 0
      || docker(['volume', 'inspect', workspace.volume]).status === 0) cli(['destroy', '--yes']);
  }
  for (const dir of [remotesDir, fileDir]) {
    const path = resolve(dir);
    assert.equal(dirname(path), resolve(tmpdir()));
    assert.ok(basename(path).startsWith('suped-move-'));
    rmSync(path, { recursive: true, force: true });
  }
}
console.log('PASS a workspace moves: both test workspaces removed');

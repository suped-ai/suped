import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionManifest, missingHere, createState, STATE_DIR, STATE_FILE } from '../lib/state.js';

const base = { version: 1, suped: '0.4.0', tools: [], ports: [], mounts: [], installed: { apt: [], uv: [], npm: [] }, projects: [] };
const of = (over) => ({ ...base, ...over });

test('two machines each adding a tool have not conflicted; they have both added a tool', () => {
  const merged = unionManifest(of({ tools: ['github', 'go'] }), of({ tools: ['github', 'python'] }));
  assert.deepEqual(merged.tools, ['github', 'go', 'python']);
});

test('everything that defines a workspace merges as a set, and stays sorted for a diff', () => {
  const merged = unionManifest(
    of({ tools: ['vercel'], installed: { apt: ['tree'], uv: ['ruff'], npm: [] } }),
    of({ tools: ['neon'], installed: { apt: ['jq', 'tree'], uv: [], npm: ['pnpm'] } }),
  );
  assert.deepEqual(merged.tools, ['neon', 'vercel']);
  assert.deepEqual(merged.installed, { apt: ['jq', 'tree'], uv: ['ruff'], npm: ['pnpm'] });
});

test('projects merge by path, and the local entry wins where both know one', () => {
  // This checkout is the truth about where that clone actually points.
  const theirs = of({ projects: [{ path: 'projects/a', remote: 'git@old', branch: 'main' }, { path: 'projects/b', remote: 'git@b', branch: 'main' }] });
  const mine = of({ projects: [{ path: 'projects/a', remote: 'git@new', branch: 'work' }] });
  const merged = unionManifest(theirs, mine);
  assert.deepEqual(merged.projects.map((p) => p.path), ['projects/a', 'projects/b']);
  assert.deepEqual(merged.projects[0], { path: 'projects/a', remote: 'git@new', branch: 'work' });
});

test('ports and mounts are never shared, however either side describes them', () => {
  // A mount names a host path the other machine does not have, and a published
  // port says where the workspace runs rather than what it is.
  const merged = unionManifest(
    of({ ports: ['3000:3000'], mounts: ['/home/nick/data:/home/suped/data'] }),
    of({ ports: ['8080:80'], mounts: ['/Users/other/x:/home/suped/x'] }),
  );
  assert.deepEqual(merged.ports, []);
  assert.deepEqual(merged.mounts, []);
});

test('union is order-independent for the fields that are sets', () => {
  const a = of({ tools: ['go', 'bun'], installed: { apt: ['tree'], uv: [], npm: [] } });
  const b = of({ tools: ['python'], installed: { apt: ['jq'], uv: [], npm: [] } });
  const one = unionManifest(a, b);
  const other = unionManifest(b, a);
  assert.deepEqual(one.tools, other.tools);
  assert.deepEqual(one.installed, other.installed);
});

test('a missing or empty side merges without throwing', () => {
  assert.deepEqual(unionManifest({}, of({ tools: ['go'] })).tools, ['go']);
  assert.deepEqual(unionManifest(of({ tools: ['go'] }), {}).tools, ['go']);
  assert.deepEqual(unionManifest().tools, []);
});

test('what a machine is missing counts only what it does not already have', () => {
  const shared = of({ tools: ['github', 'go'], projects: [{ path: 'projects/a' }, { path: 'notes/vault' }] });
  const mine = of({ tools: ['github'], projects: [{ path: 'projects/a' }] });
  const gained = missingHere(shared, mine);
  assert.deepEqual(gained.tools, ['go']);
  assert.deepEqual(gained.projects.map((p) => p.path), ['notes/vault']);
  assert.deepEqual(missingHere(mine, mine), { tools: [], projects: [] });
});

// --- the command surface, with git and the workspace faked -------------------

function fixture({ repo = true, remote = null, shared = null, mine = of({}), reachable = true, restoreResult = 0 } = {}) {
  const logs = [];
  const scripts = [];
  let written = null;
  const capture = (argv, options = {}) => {
    const script = argv[2] ?? '';
    scripts.push(script);
    if (script.includes(`test -d "${STATE_DIR}/.git"`)) return { status: repo ? 0 : 1, stdout: '', stderr: '' };
    if (script.includes('symbolic-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (script.includes('remote get-url')) return remote ? { status: 0, stdout: `${remote}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    if (script.includes('fetch -q origin')) return { status: reachable ? 0 : 1, stdout: '', stderr: '' };
    if (script.includes(`show origin/main:${STATE_FILE}`)) {
      return shared ? { status: 0, stdout: JSON.stringify(shared), stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (script.includes(`show HEAD:${STATE_FILE}`)) return { status: 1, stdout: '', stderr: '' };
    if (script.includes(`cat > "${STATE_DIR}/${STATE_FILE}"`)) { written = JSON.parse(options.input); return { status: 0, stdout: '', stderr: '' }; }
    // Everything else (rev-parse, reset, add, commit, push, diff) succeeds.
    if (script.includes('diff --cached --quiet')) return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const state = createState({
    capture,
    log: (message) => logs.push(message),
    makeSync: () => ({
      describe: () => ({ manifest: mine, atRisk: [] }),
      restore: async () => restoreResult,
      status: () => 0,
    }),
  });
  return { state, logs, scripts, written: () => written, output: () => logs.join('\n') };
}

test('status explains how to start when there is no shared state, without inventing one', () => {
  const f = fixture({ repo: false });
  assert.equal(f.state.status(), 0);
  assert.match(f.output(), /No shared state yet/);
  assert.match(f.output(), /suped state init/);
  assert.equal(f.scripts.some((s) => s.includes('git init')), false, 'status never changes anything');
});

test('sync refuses before there is a repository rather than guessing', async () => {
  const f = fixture({ repo: false });
  await assert.rejects(f.state.sync(), /no shared state here yet/);
});

test('sync converges on what the shared state has, then records the union', async () => {
  const f = fixture({
    remote: 'git@github.com:me/state.git',
    shared: of({ tools: ['github', 'go'], projects: [{ path: 'projects/a', remote: 'git@a', branch: 'main' }] }),
    mine: of({ tools: ['github'], projects: [] }),
  });
  assert.equal(await f.state.sync(), 0);
  assert.match(f.output(), /Bringing this workspace up to date/);
  assert.match(f.output(), /go/);
  assert.deepEqual(f.written().tools, ['github', 'go']);
  assert.deepEqual(f.written().projects.map((p) => p.path), ['projects/a']);
  assert.ok(f.scripts.some((s) => s.includes('push -q origin HEAD:main')), 'the result is pushed');
});

test('a workspace already in step converges nothing and says so', async () => {
  const same = of({ tools: ['github'], projects: [{ path: 'projects/a', remote: 'git@a', branch: 'main' }] });
  const f = fixture({ remote: 'git@github.com:me/state.git', shared: same, mine: same });
  assert.equal(await f.state.sync(), 0);
  assert.match(f.output(), /already matches the shared state/);
  assert.doesNotMatch(f.output(), /Bringing this workspace up to date/);
});

test('an unreachable remote still records locally instead of failing the whole run', async () => {
  const f = fixture({ remote: 'git@github.com:me/state.git', shared: of({ tools: ['go'] }), mine: of({}), reachable: false });
  await f.state.sync();
  assert.match(f.output(), /Could not reach/);
  assert.match(f.output(), /working from what is here/);
});

test('a workspace with no remote records its state and says what is missing', async () => {
  const f = fixture({ remote: null, mine: of({ tools: ['github'] }) });
  assert.equal(await f.state.sync(), 0);
  assert.deepEqual(f.written().tools, ['github']);
  assert.match(f.output(), /No remote yet/);
  assert.equal(f.scripts.some((s) => s.includes('push')), false);
});

test('a convergence that could not finish is reported rather than recorded as success', async () => {
  const f = fixture({
    remote: 'git@github.com:me/state.git',
    shared: of({ tools: ['github', 'go'] }),
    mine: of({ tools: ['github'] }),
    restoreResult: 1,
  });
  assert.equal(await f.state.sync(), 1);
});

test('a shared state that cannot be read stops the run instead of being overwritten', async () => {
  // Treating an unreadable shared file as empty is worse than an error: the
  // next write would replace it with only this machine's half, quietly
  // deleting every other machine's contribution.
  let wrote = false;
  const capture = (argv) => {
    const script = argv[2] ?? '';
    if (script.includes(`test -d "${STATE_DIR}/.git"`)) return { status: 0, stdout: '', stderr: '' };
    if (script.includes('symbolic-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (script.includes('remote get-url')) return { status: 0, stdout: 'git@github.com:me/state.git\n', stderr: '' };
    if (script.includes(`show origin/main:${STATE_FILE}`)) return { status: 0, stdout: '{ this is not json', stderr: '' };
    if (script.includes(`cat > "${STATE_DIR}/${STATE_FILE}"`)) { wrote = true; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  const state = createState({
    capture, log: () => {},
    makeSync: () => ({ describe: () => ({ manifest: of({ tools: ['github'] }), atRisk: [] }), restore: async () => 0, status: () => 0 }),
  });
  await assert.rejects(state.sync(), /not valid JSON/);
  assert.equal(wrote, false, 'nothing is written over a shared state that could not be read');
});

test('a shared state written by a newer Suped is refused by name, not ignored', async () => {
  const capture = (argv) => {
    const script = argv[2] ?? '';
    if (script.includes(`test -d "${STATE_DIR}/.git"`)) return { status: 0, stdout: '', stderr: '' };
    if (script.includes('symbolic-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (script.includes('remote get-url')) return { status: 1, stdout: '', stderr: '' };
    if (script.includes(`show HEAD:${STATE_FILE}`)) return { status: 0, stdout: JSON.stringify(of({ version: 99 })), stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const state = createState({
    capture, log: () => {},
    makeSync: () => ({ describe: () => ({ manifest: of({}), atRisk: [] }), restore: async () => 0, status: () => 0 }),
  });
  await assert.rejects(state.sync(), /unsupported version 99/);
});

test('the shared branch comes from the remote, not from whatever HEAD happens to be', async () => {
  // A bare repository created without -b leaves HEAD on a branch nothing ever
  // pushes, so a clone of it lands on an unborn branch of the wrong name.
  // Reading the state from that branch finds nothing -- silently, and it looks
  // exactly like a workspace that is already in step.
  const seen = [];
  let recorded = null;
  const capture = (argv, options = {}) => {
    const script = argv[2] ?? '';
    seen.push(script);
    if (script.includes(`test -d "${STATE_DIR}/.git"`)) return { status: 0, stdout: '', stderr: '' };
    if (script.includes('symbolic-ref')) return { status: 0, stdout: 'master\n', stderr: '' };
    if (script.includes('remote get-url')) return { status: 0, stdout: 'git@github.com:me/state.git\n', stderr: '' };
    if (script.includes('rev-parse --verify --quiet origin/main')) return { status: 0, stdout: '', stderr: '' };
    if (script.includes('rev-parse --verify --quiet origin/master')) return { status: 1, stdout: '', stderr: '' };
    if (script.includes(`show origin/main:${STATE_FILE}`)) {
      return { status: 0, stdout: JSON.stringify(of({ tools: ['github', 'go'] })), stderr: '' };
    }
    if (script.includes(`show origin/master:${STATE_FILE}`)) return { status: 1, stdout: '', stderr: '' };
    if (script.includes(`cat > "${STATE_DIR}/${STATE_FILE}"`)) { recorded = JSON.parse(options.input); return { status: 0, stdout: '', stderr: '' }; }
    if (script.includes('diff --cached --quiet')) return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const state = createState({
    capture, log: () => {},
    makeSync: () => ({ describe: () => ({ manifest: of({ tools: ['github'] }), atRisk: [] }), restore: async () => 0, status: () => 0 }),
  });
  assert.equal(await state.sync(), 0);
  assert.deepEqual(recorded.tools, ['github', 'go'], 'the state was read from the branch the remote actually has');
  assert.ok(seen.some((s) => s.includes('push -q origin HEAD:main')), 'and pushed back to that same branch');
  assert.equal(seen.some((s) => s.includes('HEAD:master')), false);
});

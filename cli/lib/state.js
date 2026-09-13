// Shared workspace state, kept in git.
//
// `sync` moves a workspace once, deliberately, to a file you carry. That is a
// different job from several machines staying in step, which is what this is:
// the definition lives in a repository, each machine converges on it, and
// `git log` is the workspace's history.
//
// The state lives in the workspace rather than on the host, so it travels with
// the home volume and pushes using the GitHub connection the workspace already
// has. Nothing new to authenticate.
import * as computer from './computer.js';
import { createSync, validateManifest } from './sync.js';

export const STATE_DIR = '$HOME/.config/suped/state';
export const STATE_FILE = 'workspace.json';

/**
 * Two machines that each added a tool have not conflicted; they have both
 * added a tool. Nearly everything that defines a workspace is a set, which is
 * what makes converging automatic rather than a JSON merge conflict someone
 * has to resolve by hand.
 */
export function unionManifest(theirs = {}, mine = {}) {
  const merge = (a = [], b = []) => [...new Set([...a, ...b])].sort();
  const byPath = new Map();
  // For a path both machines know, the local entry wins: this checkout is the
  // truth about where that clone actually points.
  for (const project of theirs.projects ?? []) byPath.set(project.path, project);
  for (const project of mine.projects ?? []) byPath.set(project.path, project);
  return {
    version: mine.version ?? theirs.version,
    suped: mine.suped ?? theirs.suped,
    tools: merge(theirs.tools, mine.tools),
    // Machine-local on purpose. A mount names a host path the other machine
    // does not have, and a published port describes where the workspace is
    // running rather than what it is. Both already live on the container.
    ports: [],
    mounts: [],
    installed: {
      apt: merge(theirs.installed?.apt, mine.installed?.apt),
      uv: merge(theirs.installed?.uv, mine.installed?.uv),
      npm: merge(theirs.installed?.npm, mine.installed?.npm),
    },
    projects: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** What this machine would gain by converging on the shared state. */
export function missingHere(shared, mine) {
  const paths = new Set((mine.projects ?? []).map((project) => project.path));
  return {
    tools: (shared.tools ?? []).filter((id) => !(mine.tools ?? []).includes(id)),
    projects: (shared.projects ?? []).filter((project) => !paths.has(project.path)),
  };
}

export function createState({
  capture = computer.capture,
  log = (message) => console.log(message),
  makeSync = (options) => createSync(options),
  dir = STATE_DIR,
} = {}) {
  const file = `${dir}/${STATE_FILE}`;
  const sh = (script, options) => capture(['bash', '-lc', script], options);
  const git = (args) => sh(`cd "${dir}" && git ${args}`);
  const indent = (message) => log(message ? `  ${message}` : '');

  // `sync` reads and writes on the host by default. The state lives in the
  // workspace, so point its file access there and everything else is reused.
  const sync = () => makeSync({
    log: indent,
    readFile: (path) => {
      const result = sh(`cat "${path}"`);
      if (result.status !== 0) throw new Error(`could not read ${path}`);
      return result.stdout;
    },
    writeFile: (path, text) => {
      const written = sh(`set -e; mkdir -p "$(dirname "${path}")"; cat > "${path}"`, { input: text });
      if (written.status !== 0) throw new Error(`could not write ${path}`);
    },
  });

  const isRepo = () => sh(`test -d "${dir}/.git"`).status === 0;
  const branch = () => git('symbolic-ref --quiet --short HEAD').stdout.trim() || 'main';

  function remoteUrl() {
    const result = git('remote get-url origin 2>/dev/null');
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }

  function requireRepo() {
    if (!isRepo()) throw new Error(`no shared state here yet; "suped state init [remote]" starts one`);
  }

  /**
   * The shared definition: what the remote has, else what is committed here.
   *
   * A file that is present but unreadable stops the run. Treating it as empty
   * would be worse than an error: the next write replaces the shared state
   * with only this machine's half, so a parse failure would quietly delete
   * every other machine's contribution.
   */
  function readShared() {
    for (const ref of [`origin/${branch()}`, 'HEAD']) {
      const result = git(`show ${ref}:${STATE_FILE} 2>/dev/null`);
      if (result.status !== 0 || !result.stdout.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(result.stdout); }
      catch { throw new Error(`the shared state in ${ref}:${STATE_FILE} is not valid JSON; repair it in ${dir} before syncing`); }
      return validateManifest(parsed);
    }
    return {};
  }

  function writeState(manifest) {
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const written = sh(`set -e; mkdir -p "${dir}"; cat > "${file}"`, { input: text });
    if (written.status !== 0) throw new Error(`could not write ${file}`);
  }

  function describeHere() {
    return sync().describe().manifest;
  }

  async function init(remote) {
    if (isRepo()) {
      if (remote && !remoteUrl()) git(`remote add origin "${remote}"`);
      log(`Shared state is already a repository at ${dir}`);
      return sync_();
    }
    // An existing remote with content is the truth; adopt it rather than
    // starting a competing history that would have to be reconciled later.
    const populated = remote && sh(`git ls-remote "${remote}" 2>/dev/null | head -1`).stdout.trim();
    if (populated) {
      const cloned = sh(`set -e; mkdir -p "$(dirname "${dir}")"; git clone -q "${remote}" "${dir}"`);
      if (cloned.status !== 0) throw new Error(`could not clone ${remote}: ${cloned.stderr.trim()}`);
      log(`Adopted the shared state from ${remote}`);
    } else {
      const made = sh(`set -e; mkdir -p "${dir}"; cd "${dir}"; git init -q -b main`);
      if (made.status !== 0) throw new Error(`could not start a repository at ${dir}: ${made.stderr.trim()}`);
      if (remote) git(`remote add origin "${remote}"`);
      log(`Started shared state at ${dir}${remote ? `, pushing to ${remote}` : ''}`);
    }
    return sync_();
  }

  async function sync_() {
    requireRepo();
    const url = remoteUrl();
    if (url && git('fetch -q origin').status !== 0) {
      log(`Could not reach ${url}; working from what is here.`);
    }

    const shared = readShared();
    const mine = describeHere();
    const merged = unionManifest(shared, mine);
    const gained = missingHere(merged, mine);

    // Discarding local commits is safe: this machine's half of the union comes
    // from the workspace itself, not from the file, so nothing is lost and the
    // history stays linear and pushable.
    if (url && git(`rev-parse --verify --quiet origin/${branch()}`).status === 0) {
      git(`reset --hard -q origin/${branch()}`);
    }
    writeState(merged);

    let failed = false;
    if (gained.tools.length || gained.projects.length) {
      log(`\nBringing this workspace up to date:`);
      if (gained.tools.length) indent(`tools     ${gained.tools.join(', ')}`);
      if (gained.projects.length) indent(`projects  ${gained.projects.map((p) => p.path).join(', ')}`);
      log('');
      failed = await sync().restore(file) !== 0;
      // Converging changed this machine, so record what it actually is now.
      writeState(unionManifest(merged, describeHere()));
    } else {
      log('\nNothing to bring over; this workspace already matches the shared state.');
    }

    const staged = git(`add "${STATE_FILE}"`);
    if (staged.status !== 0) throw new Error(`could not stage the state: ${staged.stderr.trim()}`);
    const changed = git('diff --cached --quiet').status !== 0;
    if (changed) {
      const message = `workspace state from ${computer.CONTAINER}`;
      const committed = git(`-c user.name=suped -c user.email=suped@localhost commit -q -m "${message}"`);
      if (committed.status !== 0) throw new Error(`could not record the state: ${committed.stderr.trim()}`);
      log('Recorded this machine\'s state.');
    } else {
      log('Shared state already matched; nothing to record.');
    }

    if (url) {
      const pushed = git(`push -q origin HEAD:${branch()}`);
      if (pushed.status !== 0) {
        log(`Could not push to ${url}: ${pushed.stderr.trim() || 'rejected'}`);
        log('Run "suped state sync" again once the remote is reachable.');
        failed = true;
      } else if (changed) log(`Pushed to ${url}.`);
    } else {
      log('No remote yet. Add one with "suped state init <url>" so other machines can see this.');
    }
    return failed ? 1 : 0;
  }

  function status() {
    if (!isRepo()) {
      log(`No shared state yet.\n\nStart one with "suped state init <git-url>". Other machines that`);
      log('run the same command against that URL converge on the same workspace.');
      return 0;
    }
    const url = remoteUrl();
    if (url) git('fetch -q origin');
    const shared = readShared();
    const mine = describeHere();
    const gained = missingHere(shared, mine);
    const added = missingHere(mine, shared);

    log('Shared workspace state\n');
    log(`repository ${dir}`);
    log(`remote     ${url ?? 'none yet'}`);
    log(`shared     ${(shared.tools ?? []).length} tool(s), ${(shared.projects ?? []).length} project(s)`);
    if (gained.tools.length || gained.projects.length) {
      log(`\nThis machine is missing:`);
      if (gained.tools.length) indent(`tools     ${gained.tools.join(', ')}`);
      if (gained.projects.length) indent(`projects  ${gained.projects.map((p) => p.path).join(', ')}`);
    }
    if (added.tools.length || added.projects.length) {
      log(`\nThis machine has, and the shared state does not:`);
      if (added.tools.length) indent(`tools     ${added.tools.join(', ')}`);
      if (added.projects.length) indent(`projects  ${added.projects.map((p) => p.path).join(', ')}`);
    }
    if (!gained.tools.length && !gained.projects.length && !added.tools.length && !added.projects.length) {
      log('\nIn step with the shared state.');
    }
    log('\nBring both sides together with "suped state sync".');
    log('Ports and mounts are not shared: they describe where a workspace runs, not what it is.');
    return 0;
  }

  return { init, sync: sync_, status };
}

export async function mainState(args, { runArgs = [] } = {}) {
  const [action = 'status', ...rest] = args;
  const known = ['status', 'init', 'sync'];
  if (!known.includes(action)) {
    throw new Error(`unknown state command "${action}". Try: suped state | suped state init [url] | suped state sync`);
  }
  computer.ensureUp({ runArgs, log: (message) => console.error(`suped: ${message}`) });
  const state = createState();
  if (action === 'init') return state.init(rest[0]);
  if (action === 'sync') return state.sync();
  return state.status();
}

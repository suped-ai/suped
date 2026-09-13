// One command for the thing a person actually does: take this workspace
// somewhere else. Moving a workspace needs both halves -- what it is, and what
// it can sign into -- and asking someone to remember two commands and two
// filenames is how half a move happens.
//
// It composes sync and secrets rather than replacing them. Both stay usable on
// their own, because they are genuinely different things and a person sometimes
// wants exactly one of them: `sync save` is how you share a workspace's shape
// with someone else, and that must never be a command that could include a
// credential by accident.
//
// The two stay TWO FILES, deliberately. The manifest is plain text meant to
// live in git and be read in a diff; the sealed store is opaque and, because
// age re-randomises on every write, changes completely each time it is saved.
// Folding them together would make every save a whole-file diff and destroy the
// property the manifest exists to have.
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as computer from './computer.js';

export const MANIFEST_NAME = 'workspace.json';
export const SECRETS_NAME = 'secrets.age';

export function createMove({
  log = (message) => console.log(message),
  makeSync,
  makeSecrets,
  // Moving is exactly when work in progress should come along. `sync save` on
  // its own stays a read of the workspace; this is the command that moves you.
  carryWork = true,
  exists = (path) => existsSync(path),
  makeDir = (path) => mkdirSync(path, { recursive: true }),
} = {}) {
  // Their own output is worth keeping -- it says what was carried and what was
  // left -- so it is indented under a heading rather than swallowed.
  const section = (title) => { log(`\n${title}`); return (message) => log(message ? `  ${message}` : ''); };

  function paths(dir) {
    if (!dir) throw new Error('usage: suped move save <directory>   (or: suped move restore <directory>)');
    return { manifest: join(dir, MANIFEST_NAME), secrets: join(dir, SECRETS_NAME) };
  }

  function save(dir) {
    const { manifest, secrets } = paths(dir);
    makeDir(dir);
    log(`Saving this workspace to ${dir}`);

    makeSync({ log: section(MANIFEST_NAME), carryWork }).save(manifest);
    // A workspace with nothing signed in has nothing to seal, which is a
    // complete move and not a failure -- but it must be said, not implied.
    const sealed = makeSecrets({ log: section(SECRETS_NAME) }).save(secrets) === 0;

    log('\nTo finish the move:');
    log(`  1. copy ${dir} to the other machine`);
    if (sealed) {
      log('  2. copy your identity file there too, if it is not already there:');
      log('       suped secrets key          (on this machine, to see where it is)');
      log(`  3. suped move restore ${dir}`);
      log('\nThe identity is deliberately not in this directory. Everything here is');
      log('safe to commit; the identity is the one thing that is not.');
    } else {
      log(`  2. suped move restore ${dir}`);
      log('\nNo credentials were sealed, so nothing here is secret and no identity is');
      log('needed. Sign in on the other machine with "suped login <tool>".');
    }
    return 0;
  }

  async function restore(dir) {
    const { manifest, secrets } = paths(dir);
    if (!exists(manifest)) {
      throw new Error(`no ${MANIFEST_NAME} in ${dir}; "suped move save <directory>" writes one`);
    }
    log(`Restoring a workspace from ${dir}`);

    let failed = await makeSync({ log: section(MANIFEST_NAME) }).restore(manifest) !== 0;
    if (exists(secrets)) {
      // Tools have to exist before they can be signed in, so this follows.
      if (makeSecrets({ log: section(SECRETS_NAME) }).restore(secrets) !== 0) failed = true;
    } else {
      const say = section(SECRETS_NAME);
      say('not in this directory, so no credentials came across');
      say('sign in with "suped login <tool>"');
    }

    log(failed ? '\nSome of the move did not complete; the messages above say which part.'
      : '\nMoved. Check it with "suped tools".');
    return failed ? 1 : 0;
  }

  function status() {
    log('What would travel');
    makeSync({ log: section('workspace') }).status();
    makeSecrets({ log: section('account access') }).status();
    log('\nWrite both with "suped move save <directory>".');
    return 0;
  }

  return { save, restore, status };
}

export async function mainMove(args, { runArgs = [], flags = new Set() } = {}) {
  const [action = 'status', ...rest] = args;
  const known = ['status', 'save', 'restore'];
  if (!known.includes(action)) {
    throw new Error(`unknown move command "${action}". Try: suped move | suped move save <directory> | suped move restore <directory>`);
  }
  computer.ensureUp({ runArgs, log: (message) => console.error(`suped: ${message}`) });
  const { createSync } = await import('./sync.js');
  const { createSecrets } = await import('./secrets.js');
  const move = createMove({
    makeSync: (options) => createSync(options),
    makeSecrets: (options) => createSecrets({ ...options, flags }),
    carryWork: !flags.has('no-work'),
  });
  if (action === 'save') return move.save(rest[0]);
  if (action === 'restore') return move.restore(rest[0]);
  return move.status();
}

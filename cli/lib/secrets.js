// Move account access between machines. `sync` deliberately carries no
// credentials; this is the opt-in, separate step that does, so exporting them
// is never something that happens because you ran something else.
//
// The crypto and the file format live in authsy.js, which knows nothing about
// Suped. This file is the glue: which tools can hand a secret over, and where
// the sealed file goes.

import { readFileSync, writeFileSync } from 'node:fs';
import * as computer from './computer.js';
import { createAuthsy, DEFAULT_IDENTITY } from './authsy.js';
import { TOOLS } from './tools.js';

/** Tools that can hand their credential over. Everything else re-authenticates. */
export function portableTools(tools = TOOLS) {
  return tools.filter((tool) => tool.secret && Array.isArray(tool.secret.export) && Array.isArray(tool.secret.import));
}

export function createSecrets({
  capture = computer.capture,
  log = (message) => console.log(message),
  readFile = (file) => readFileSync(file, 'utf8'),
  writeFile = (file, text) => writeFileSync(file, text, { mode: 0o600 }),
  write = (text) => process.stdout.write(text),
  identityPath = DEFAULT_IDENTITY,
  tools = TOOLS,
  authsy = createAuthsy({ capture }),
} = {}) {

  /** What could travel, what is signed in, and what would have to be redone. */
  function survey() {
    const portable = portableTools(tools);
    const carried = [];
    for (const tool of portable) {
      const result = capture(tool.secret.export);
      const value = (result.stdout || '').trim();
      if (result.status === 0 && value) carried.push({ tool, value });
    }
    const redo = tools.filter((tool) => !tool.secret);
    return { portable, carried, redo };
  }

  function status() {
    const { portable, carried, redo } = survey();
    const have = new Set(carried.map((entry) => entry.tool.id));
    log('Account access\n');
    if (!portable.length) log('No tool in this workspace can hand its credential over yet.');
    for (const tool of portable) {
      log(`  ${tool.name.padEnd(14)} ${have.has(tool.id) ? 'signed in; will travel' : 'not signed in; nothing to carry'}`);
    }
    log(`\n${redo.length} other tool(s) re-authenticate on the new machine with "suped login <tool>".`);
    log('Providers are added one at a time, each verified against a real login.');
    const recipient = authsy.available() ? authsy.recipientFor(identityPath, { missingOk: true }) : null;
    log(`\nidentity   ${recipient ? `${identityPath} (${recipient})` : 'none yet — "suped secrets key" makes one'}`);
    log('\nThe sealed file is safe to commit. The identity is not: move it between');
    log('machines yourself, once, and anything holding it can open every secret inside.');
    return 0;
  }

  /** Make this workspace's identity, or show the one it has. */
  function key() {
    const { recipient, created } = authsy.ensureIdentity(identityPath);
    log(created ? `created an identity at ${identityPath}` : `identity already at ${identityPath}`);
    log(`recipient  ${recipient}`);
    if (created) {
      log('\nBack this file up somewhere only you can reach, and copy it to any machine');
      log('that must open these secrets. Lose it and the sealed files cannot be opened.');
    }
    return 0;
  }

  /** Collect what the signed-in tools will hand over, and seal it. */
  function save(file) {
    const { recipient } = authsy.ensureIdentity(identityPath);
    const { carried } = survey();
    if (!carried.length) {
      log('Nothing to seal: no tool that can hand its credential over is signed in.');
      return 1;
    }
    const secrets = Object.fromEntries(carried.map((entry) => [entry.tool.id, entry.value]));
    const ciphertext = authsy.seal({ secrets, recipient });
    if (file === '-') write(ciphertext);
    else {
      writeFile(file, ciphertext);
      log(`wrote ${file}`);
    }
    log(`sealed ${carried.length} credential(s): ${carried.map((entry) => entry.tool.id).join(', ')}`);
    log('Encrypted to this workspace\'s identity. Commit it anywhere; it is useless without the key.');
    return 0;
  }

  /** Open a sealed file and sign each tool in with what it holds. */
  function restore(file) {
    if (!file) throw new Error('usage: suped secrets restore <file>');
    let ciphertext;
    try { ciphertext = readFile(file); }
    catch (error) { throw new Error(`could not read ${file}: ${error.message}`); }

    const secrets = authsy.unseal({ ciphertext, identityPath });
    const known = new Map(portableTools(tools).map((tool) => [tool.id, tool]));
    let failed = false;
    let restored = 0;
    for (const [id, value] of Object.entries(secrets)) {
      const tool = known.get(id);
      if (!tool) {
        log(`  skipped ${id} (this Suped has no tool that can take it)`);
        continue;
      }
      // The secret goes in on stdin. It must never reach a command line.
      const result = capture(tool.secret.import, { input: `${value}\n` });
      if (result.status !== 0) {
        log(`  ${tool.name}: could not sign in; run "suped login ${tool.id}". ${(result.stderr || '').trim().split('\n')[0]}`);
        failed = true;
        continue;
      }
      if (tool.afterLogin) capture(tool.afterLogin);
      log(`  ${tool.name}: signed in`);
      restored += 1;
    }
    log(`\nRestored ${restored} credential(s). Check them with "suped tools".`);
    return failed ? 1 : 0;
  }

  return { status, key, save, restore, survey };
}

export async function mainSecrets(args, { runArgs = [] } = {}) {
  const [action = 'status', ...rest] = args;
  if (!['status', 'key', 'save', 'restore'].includes(action)) {
    throw new Error(`unknown secrets command "${action}". Try: suped secrets | suped secrets key | suped secrets save <file> | suped secrets restore <file>`);
  }
  computer.ensureUp({ runArgs, log: (message) => console.error(`suped: ${message}`) });
  const secrets = createSecrets();
  if (action === 'key') return secrets.key();
  if (action === 'save') return secrets.save(rest[0] ?? '-');
  if (action === 'restore') return secrets.restore(rest[0]);
  return secrets.status();
}

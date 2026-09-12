// Account access that travels. `sync` deliberately carries no credentials; this
// is the opt-in, separate thing that does.
//
// The store is one age-encrypted file in the workspace. It holds three kinds of
// entry: a `token` a tool can be signed back in with, an `email` mailbox the
// user already owns, and an `account` at some service. Suped does not sign
// anyone up -- the agent does that with a browser and a shell like a person
// would -- but it holds the mailbox to sign up with, records what came back,
// and has somewhere to put an account a person had to create by hand.
//
// The crypto and the record format live in credy.js, which knows nothing about
// Suped. This file is the glue.

import { readFileSync, writeFileSync } from 'node:fs';
import * as computer from './computer.js';
import { createCredy, redactEntry, validateEntry, DEFAULT_IDENTITY, KINDS } from './credy.js';
import { TOOLS } from './tools.js';

/** The store lives in the home, so it survives reset like everything else there. */
export const DEFAULT_STORE = '$HOME/.config/suped/secrets.age';

/** Tools that can hand their credential over. Everything else re-authenticates. */
export function portableTools(tools = TOOLS) {
  return tools.filter((tool) => tool.secret && Array.isArray(tool.secret.export) && Array.isArray(tool.secret.import));
}

/** One line per entry, enough to see what is there without opening anything. */
export function describeEntry(id, entry) {
  const bits = [id.padEnd(18), entry.kind.padEnd(8)];
  if (entry.kind === 'email') bits.push(entry.address);
  if (entry.kind === 'token') bits.push(entry.value ? 'set' : 'empty');
  if (entry.kind === 'account') {
    bits.push(entry.service);
    if (entry.status === 'pending') bits.push('— WAITING ON YOU' + (entry.needs?.length ? `: ${entry.needs.join(', ')}` : ''));
  }
  return `  ${bits.join('  ')}`.trimEnd();
}

export function createSecrets({
  capture = computer.capture,
  log = (message) => console.log(message),
  readFile = (file) => readFileSync(file, 'utf8'),
  writeFile = (file, text) => writeFileSync(file, text, { mode: 0o600 }),
  write = (text) => process.stdout.write(text),
  readStdin = () => readFileSync(0, 'utf8'),
  identityPath = DEFAULT_IDENTITY,
  storePath = DEFAULT_STORE,
  tools = TOOLS,
  credy = createCredy({ capture }),
} = {}) {

  // ---- the store -----------------------------------------------------------

  function loadStore() {
    const result = capture(['bash', '-lc', `cat "${storePath}" 2>/dev/null`]);
    if (result.status !== 0 || !result.stdout.trim()) return {};
    return credy.unseal({ ciphertext: result.stdout, identityPath });
  }

  function saveStore(entries) {
    const { recipient } = credy.ensureIdentity(identityPath);
    const ciphertext = credy.seal({ entries, recipient });
    const written = capture(['bash', '-lc',
      `set -e; umask 077; mkdir -p "$(dirname "${storePath}")"; cat > "${storePath}"`], { input: ciphertext });
    if (written.status !== 0) throw new Error(`could not write the store: ${written.stderr.trim()}`);
    return ciphertext;
  }

  // ---- reading -------------------------------------------------------------

  function list() {
    const entries = loadStore();
    const ids = Object.keys(entries).sort();
    if (!ids.length) {
      log('The store is empty. Add something with "suped secrets set <id>".');
      return 0;
    }
    log(`${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}\n`);
    for (const id of ids) log(describeEntry(id, entries[id]));
    const waiting = ids.filter((id) => entries[id].status === 'pending');
    if (waiting.length) {
      log(`\n${waiting.length} account(s) are waiting on you. Finish the signup, then:`);
      log('  suped secrets set <id>   (with the finished record on stdin)');
    }
    return 0;
  }

  function show(id, { reveal = false } = {}) {
    const entries = loadStore();
    const entry = entries[id];
    if (!entry) throw new Error(`no entry ${id}; run "suped secrets list"`);
    write(`${JSON.stringify(reveal ? entry : redactEntry(entry), null, 2)}\n`);
    if (!reveal) log('\n(secrets hidden; add --reveal to print them)');
    return 0;
  }

  // ---- writing -------------------------------------------------------------

  /** Takes one entry as JSON on stdin, so a value never reaches a command line. */
  function set(id) {
    if (!id) throw new Error('usage: suped secrets set <id>   (entry as JSON on stdin)');
    let entry;
    const raw = readStdin();
    if (!raw.trim()) throw new Error('nothing on stdin; pipe the entry in as JSON');
    try { entry = JSON.parse(raw); }
    catch { throw new Error('stdin was not JSON; pipe one entry, e.g. {"kind":"token","value":"..."}'); }
    validateEntry(id, entry);
    const entries = loadStore();
    const existed = Boolean(entries[id]);
    entries[id] = entry;
    saveStore(entries);
    log(`${existed ? 'replaced' : 'added'} ${id} (${entry.kind})`);
    if (entry.kind === 'account' && entry.status === 'pending') {
      log('Marked pending: it is recorded, but nothing can use it until the signup is finished.');
    }
    return 0;
  }

  function remove(id) {
    if (!id) throw new Error('usage: suped secrets remove <id>');
    const entries = loadStore();
    if (!entries[id]) throw new Error(`no entry ${id}`);
    delete entries[id];
    saveStore(entries);
    log(`removed ${id}`);
    return 0;
  }

  // ---- tools ---------------------------------------------------------------

  /** Read the credential out of every signed-in tool that can hand one over. */
  function capture_tokens() {
    const found = {};
    for (const tool of portableTools(tools)) {
      const result = capture(tool.secret.export);
      const value = (result.stdout || '').trim();
      if (result.status === 0 && value) found[tool.id] = { kind: 'token', value };
    }
    return found;
  }

  /** Sign tools back in from whatever token entries the store holds. */
  function apply(entries) {
    const known = new Map(portableTools(tools).map((tool) => [tool.id, tool]));
    let failed = false;
    let applied = 0;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.kind !== 'token') continue;
      const tool = known.get(id);
      if (!tool) { log(`  skipped ${id} (no tool here can take it)`); continue; }
      // The secret goes in on stdin. It must never reach a command line.
      const result = capture(tool.secret.import, { input: `${entry.value}\n` });
      if (result.status !== 0) {
        log(`  ${tool.name}: could not sign in; run "suped login ${tool.id}". ${(result.stderr || '').trim().split('\n')[0]}`);
        failed = true;
        continue;
      }
      if (tool.afterLogin) capture(tool.afterLogin);
      log(`  ${tool.name}: signed in`);
      applied += 1;
    }
    return { applied, failed };
  }

  // ---- commands ------------------------------------------------------------

  function status() {
    const recipient = credy.available() ? credy.recipientFor(identityPath, { missingOk: true }) : null;
    const entries = recipient ? loadStore() : {};
    const counts = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, 0]));
    for (const entry of Object.values(entries)) counts[entry.kind] += 1;
    const pending = Object.entries(entries).filter(([, entry]) => entry.status === 'pending');

    log('Account access\n');
    log(`identity   ${recipient ? `${identityPath} (${recipient})` : 'none yet — "suped secrets key" makes one'}`);
    log(`store      ${storePath}`);
    log(`entries    ${Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ')}`);

    const carriers = portableTools(tools);
    const live = capture_tokens();
    log(`\nTools that can hand their credential over: ${carriers.length ? carriers.map((t) => t.name).join(', ') : 'none yet'}`);
    for (const tool of carriers) {
      log(`  ${tool.name.padEnd(14)} ${live[tool.id] ? 'signed in; will travel' : 'not signed in'}`);
    }
    log(`${tools.length - carriers.length} other tool(s) re-authenticate with "suped login <tool>".`);

    if (pending.length) {
      log(`\n${pending.length} account(s) waiting on you:`);
      for (const [id, entry] of pending) log(describeEntry(id, entry));
    }
    log('\nThe sealed store is safe to commit. The identity is not: move it between');
    log('machines yourself, once, and anything holding it can open every secret inside.');
    return 0;
  }

  function key() {
    const { recipient, created } = credy.ensureIdentity(identityPath);
    log(created ? `created an identity at ${identityPath}` : `identity already at ${identityPath}`);
    log(`recipient  ${recipient}`);
    if (created) {
      log('\nBack this file up somewhere only you can reach, and copy it to any machine');
      log('that must open these secrets. Lose it and the sealed files cannot be opened.');
    }
    return 0;
  }

  /** Capture what the signed-in tools will hand over, then write the store out. */
  function save(file) {
    const entries = { ...loadStore(), ...capture_tokens() };
    if (!Object.keys(entries).length) {
      log('Nothing to seal: the store is empty and no tool that can hand its credential over is signed in.');
      return 1;
    }
    const ciphertext = saveStore(entries);
    if (file === '-') write(ciphertext);
    else if (file) { writeFile(file, ciphertext); log(`wrote ${file}`); }
    log(`sealed ${Object.keys(entries).length} entr${Object.keys(entries).length === 1 ? 'y' : 'ies'}`);
    log('Encrypted to this workspace\'s identity. Commit it anywhere; it is useless without the key.');
    return 0;
  }

  /** Merge a sealed file into the store, then sign in whatever it can. */
  function restore(file) {
    if (!file) throw new Error('usage: suped secrets restore <file>');
    let ciphertext;
    try { ciphertext = readFile(file); }
    catch (error) { throw new Error(`could not read ${file}: ${error.message}`); }
    const incoming = credy.unseal({ ciphertext, identityPath });
    const merged = { ...loadStore(), ...incoming };
    saveStore(merged);
    log(`merged ${Object.keys(incoming).length} entr${Object.keys(incoming).length === 1 ? 'y' : 'ies'} into the store`);
    const { applied, failed } = apply(incoming);
    log(`\nSigned ${applied} tool(s) back in. Check them with "suped tools".`);
    const pending = Object.entries(incoming).filter(([, entry]) => entry.status === 'pending');
    if (pending.length) log(`${pending.length} account(s) came across still waiting on a person.`);
    return failed ? 1 : 0;
  }

  return { status, key, list, show, set, remove, save, restore, loadStore, saveStore };
}

export async function mainSecrets(args, { runArgs = [], flags = new Set() } = {}) {
  const [action = 'status', ...rest] = args;
  const known = ['status', 'key', 'list', 'show', 'set', 'remove', 'save', 'restore'];
  if (!known.includes(action)) {
    throw new Error(`unknown secrets command "${action}". Try one of: ${known.join(', ')}`);
  }
  computer.ensureUp({ runArgs, log: (message) => console.error(`suped: ${message}`) });
  const secrets = createSecrets();
  switch (action) {
    case 'key': return secrets.key();
    case 'list': return secrets.list();
    case 'show': return secrets.show(rest[0], { reveal: flags.has('reveal') });
    case 'set': return secrets.set(rest[0]);
    case 'remove': return secrets.remove(rest[0]);
    case 'save': return secrets.save(rest[0] ?? null);
    case 'restore': return secrets.restore(rest[0]);
    default: return secrets.status();
  }
}

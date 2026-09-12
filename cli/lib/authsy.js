// authsy: hand off scoped credentials between machines, encrypted, with no
// hosted service.
//
// This file knows nothing about Suped, Docker, or any particular provider. It
// takes named entries in and gives back one armoured blob, and the reverse. The
// only thing it needs is `age` and something that can run it. That keeps it
// liftable into its own project if it turns out to deserve one.
//
// Keypair, not passphrase: `age -p` reads the passphrase from /dev/tty and
// fails outright when there is no terminal, which is exactly the case an agent
// runs in. So one identity file is the single thing you move between machines,
// out of band and once; everything else can sit in a git repository.

export const FORMAT = 2;

/** Where a suped workspace keeps its identity. Callers may use any path. */
export const DEFAULT_IDENTITY = '$HOME/.config/suped/authsy.key';

const RECIPIENT = /^age1[0-9a-z]{20,}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * An account is not a string. A real signup leaves an address, a password, a
 * second factor and a handful of recovery codes, and the thing an agent
 * actually uses afterwards is usually an API key issued later. Storing only
 * "the secret" throws away everything needed to sign in again, recover, or
 * know which mailbox the confirmation went to.
 */
export const KINDS = {
  // One credential belonging to a tool that can take it back: a token, a key.
  token: { required: ['value'], secret: ['value'] },
  // A mailbox the user already owns. Accounts are signed up with these; a new
  // address invented per service is a liability nobody can recover.
  email: { required: ['address'], secret: ['password'] },
  // An account at a service, however it came to exist.
  account: { required: ['service'], secret: ['password', 'mfa', 'recovery', 'keys'] },
};

/** Waiting on a person, or ready for an agent to use. */
export const STATUSES = ['active', 'pending'];

/** Refuse anything that is not an age public key before it reaches a shell. */
export function assertRecipient(recipient) {
  if (typeof recipient !== 'string' || !RECIPIENT.test(recipient.trim())) {
    throw new Error(`not an age recipient: ${String(recipient).slice(0, 40)}`);
  }
  return recipient.trim();
}

export function assertId(id) {
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new Error(`not a usable id: ${String(id).slice(0, 40)} (lower case, digits, dot, dash, underscore)`);
  }
  return id;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One entry, checked hard enough that nothing downstream has to guess. */
export function validateEntry(id, entry) {
  const fail = (why) => { throw new Error(`entry ${id}: ${why}`); };
  assertId(id);
  if (!isPlainObject(entry)) fail('expected an object');
  const kind = KINDS[entry.kind];
  if (!kind) fail(`unknown kind ${JSON.stringify(entry.kind)}; expected ${Object.keys(KINDS).join(', ')}`);
  for (const field of kind.required) {
    if (typeof entry[field] !== 'string' || !entry[field]) fail(`needs a ${field}`);
  }
  for (const [field, value] of Object.entries(entry)) {
    if (value === null || value === undefined) continue;
    if (field === 'recovery') {
      if (!Array.isArray(value) || value.some((code) => typeof code !== 'string')) fail('recovery must be a list of strings');
    } else if (field === 'keys' || field === 'imap') {
      if (!isPlainObject(value)) fail(`${field} must be an object`);
      for (const [name, inner] of Object.entries(value)) {
        if (typeof inner !== 'string' && typeof inner !== 'number') fail(`${field}.${name} must be a string`);
      }
    } else if (field === 'status') {
      if (!STATUSES.includes(value)) fail(`status must be one of ${STATUSES.join(', ')}`);
    } else if (field === 'needs') {
      if (!Array.isArray(value) || value.some((need) => typeof need !== 'string')) fail('needs must be a list of strings');
    } else if (typeof value !== 'string') {
      fail(`${field} must be a string`);
    }
  }
  return entry;
}

/** A copy safe to print: metadata kept, anything secret replaced. */
export function redactEntry(entry) {
  const secretFields = KINDS[entry.kind]?.secret ?? [];
  const out = {};
  for (const [field, value] of Object.entries(entry)) {
    if (!secretFields.includes(field)) { out[field] = value; continue; }
    if (Array.isArray(value)) out[field] = value.map(() => '••••');
    else if (isPlainObject(value)) out[field] = Object.fromEntries(Object.keys(value).map((name) => [name, '••••']));
    else if (value) out[field] = '••••';
  }
  if (entry.kind === 'email' && isPlainObject(entry.imap)) {
    out.imap = { ...entry.imap, ...(entry.imap.password ? { password: '••••' } : {}) };
  }
  return out;
}

/** Format 1 held a flat map of strings. Read it as tokens rather than refuse it. */
function upgrade(payload) {
  if (payload.format === FORMAT) return payload;
  if (payload.format !== 1) {
    throw new Error(`not a usable payload: unsupported format ${payload.format}; this authsy writes ${FORMAT}`);
  }
  const entries = Object.fromEntries(
    Object.entries(payload.secrets ?? {}).map(([id, value]) => [id, { kind: 'token', value }]),
  );
  return { ...payload, format: FORMAT, entries, secrets: undefined };
}

export function validateSealed(payload) {
  const fail = (why) => { throw new Error(`not a usable payload: ${why}`); };
  if (!isPlainObject(payload)) fail('expected an object');
  if (payload.format === 1) {
    if (payload.secrets !== undefined && !isPlainObject(payload.secrets)) fail('secrets must be an object');
    for (const [id, value] of Object.entries(payload.secrets ?? {})) {
      if (typeof value !== 'string') fail(`secret ${id} must be a string`);
    }
    return upgrade(payload);
  }
  if (payload.format !== FORMAT) fail(`unsupported format ${payload.format}; this authsy writes ${FORMAT}`);
  if (!isPlainObject(payload.entries)) fail('entries must be an object');
  for (const [id, entry] of Object.entries(payload.entries)) validateEntry(id, entry);
  return payload;
}

/** Every string inside an entry that must not appear in the ciphertext. */
function secretStrings(entries) {
  const found = [];
  for (const entry of Object.values(entries)) {
    for (const field of KINDS[entry.kind]?.secret ?? []) {
      const value = entry[field];
      if (typeof value === 'string') found.push(value);
      else if (Array.isArray(value)) found.push(...value.filter((v) => typeof v === 'string'));
      else if (isPlainObject(value)) found.push(...Object.values(value).filter((v) => typeof v === 'string'));
    }
    if (entry.kind === 'email' && isPlainObject(entry.imap) && typeof entry.imap.password === 'string') {
      found.push(entry.imap.password);
    }
  }
  return found;
}

/**
 * `capture(argv, { input })` runs a command wherever the secrets live -- inside
 * a container, over ssh, or on this machine -- and must pass `input` on stdin,
 * never on a command line: that is the difference between a secret and a secret
 * in `ps`.
 */
export function createAuthsy({ capture, now = () => new Date().toISOString() } = {}) {
  if (typeof capture !== 'function') throw new Error('authsy needs a capture function');

  function available() {
    return capture(['age', '--version']).status === 0;
  }

  function requireAge() {
    if (!available()) {
      throw new Error('age is not installed where the secrets live; install it (apt-get install age) and try again');
    }
  }

  function recipientFor(identityPath = DEFAULT_IDENTITY, { missingOk = false } = {}) {
    const result = capture(['bash', '-lc', `age-keygen -y "${identityPath}" 2>/dev/null`]);
    const recipient = result.stdout.trim();
    if (result.status !== 0 || !recipient) {
      if (missingOk) return null;
      throw new Error(`no identity at ${identityPath}; run "suped secrets key" to make one`);
    }
    return assertRecipient(recipient);
  }

  function ensureIdentity(identityPath = DEFAULT_IDENTITY) {
    requireAge();
    const existing = recipientFor(identityPath, { missingOk: true });
    if (existing) return { recipient: existing, created: false };
    const made = capture(['bash', '-lc',
      `set -e; umask 077; mkdir -p "$(dirname "${identityPath}")"; age-keygen -o "${identityPath}" >/dev/null 2>&1`]);
    if (made.status !== 0) throw new Error(`could not create an identity at ${identityPath}: ${made.stderr.trim()}`);
    return { recipient: recipientFor(identityPath), created: true };
  }

  /** Named entries in, one armoured blob out. Safe to commit. */
  function seal({ entries, recipient }) {
    requireAge();
    const to = assertRecipient(recipient);
    if (!isPlainObject(entries)) throw new Error('entries must be an object of id to entry');
    for (const [id, entry] of Object.entries(entries)) validateEntry(id, entry);
    const payload = JSON.stringify({ format: FORMAT, created: now(), entries });
    const result = capture(['age', '--armor', '--recipient', to], { input: payload });
    if (result.status !== 0) throw new Error(`could not encrypt: ${result.stderr.trim()}`);
    const ciphertext = result.stdout;
    if (!ciphertext.includes('BEGIN AGE ENCRYPTED FILE')) {
      throw new Error('age did not return an encrypted file; refusing to write it');
    }
    // Cheap proof that nothing secret survived. Only for values long enough to
    // mean something: a short one occurs in base64 by chance, and a false
    // positive here would block a legitimate seal.
    for (const value of secretStrings(entries)) {
      if (value.length >= 12 && ciphertext.includes(value)) {
        throw new Error('a secret appeared in the ciphertext; refusing to write it');
      }
    }
    return ciphertext;
  }

  /** The blob and an identity back to named entries. */
  function unseal({ ciphertext, identityPath = DEFAULT_IDENTITY }) {
    requireAge();
    if (typeof ciphertext !== 'string' || !ciphertext.includes('BEGIN AGE ENCRYPTED FILE')) {
      throw new Error('that does not look like an age encrypted file');
    }
    const result = capture(['bash', '-lc', `age --decrypt --identity "${identityPath}"`], { input: ciphertext });
    if (result.status !== 0) {
      const why = result.stderr.trim();
      if (/no identity matched/.test(why)) {
        throw new Error('this machine\'s identity does not open that file; copy the identity from the machine that sealed it');
      }
      throw new Error(`could not decrypt: ${why}`);
    }
    let payload;
    try { payload = JSON.parse(result.stdout); }
    catch { throw new Error('the file decrypted but did not contain a payload'); }
    return validateSealed(payload).entries;
  }

  return { available, ensureIdentity, recipientFor, seal, unseal };
}

// authsy: hand off scoped credentials between machines, encrypted, with no
// hosted service.
//
// This file knows nothing about Suped, Docker, or any particular provider. It
// takes named secrets in and gives back one armoured blob, and the reverse. The
// only thing it needs is `age` and something that can run it. That keeps it
// liftable into its own project if it turns out to deserve one.
//
// Keypair, not passphrase: `age -p` reads the passphrase from /dev/tty and
// fails outright when there is no terminal, which is exactly the case an agent
// runs in. So one identity file is the single thing you move between machines,
// out of band and once; everything else can sit in a git repository.

export const FORMAT = 1;

/** Where a suped workspace keeps its identity. Callers may use any path. */
export const DEFAULT_IDENTITY = '$HOME/.config/suped/authsy.key';

const RECIPIENT = /^age1[0-9a-z]{20,}$/;

/** Refuse anything that is not an age public key before it reaches a shell. */
export function assertRecipient(recipient) {
  if (typeof recipient !== 'string' || !RECIPIENT.test(recipient.trim())) {
    throw new Error(`not an age recipient: ${String(recipient).slice(0, 40)}`);
  }
  return recipient.trim();
}

export function validateSealed(payload) {
  const fail = (why) => { throw new Error(`not a usable secrets payload: ${why}`); };
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) fail('expected an object');
  if (payload.format !== FORMAT) fail(`unsupported format ${payload.format}; this authsy writes ${FORMAT}`);
  if (payload.secrets === null || typeof payload.secrets !== 'object' || Array.isArray(payload.secrets)) {
    fail('secrets must be an object');
  }
  for (const [name, value] of Object.entries(payload.secrets)) {
    if (typeof value !== 'string') fail(`secret ${name} must be a string`);
  }
  return payload;
}

/**
 * `run` and `capture` execute a command wherever the secrets live -- inside a
 * container, over ssh, or on this machine. `capture(argv, { input })` must
 * return { status, stdout, stderr } and must pass `input` on stdin, never on a
 * command line: that is the difference between a secret and a secret in `ps`.
 */
export function createAuthsy({ capture, now = () => new Date().toISOString() } = {}) {
  if (typeof capture !== 'function') throw new Error('authsy needs a capture function');

  /** Is age installed where the secrets are? */
  function available() {
    return capture(['age', '--version']).status === 0;
  }

  function requireAge() {
    if (!available()) {
      throw new Error('age is not installed where the secrets live; install it (apt-get install age) and try again');
    }
  }

  /** Make an identity at `identityPath` if there is not one already. */
  function ensureIdentity(identityPath = DEFAULT_IDENTITY) {
    requireAge();
    const existing = recipientFor(identityPath, { missingOk: true });
    if (existing) return { recipient: existing, created: false };
    const made = capture(['bash', '-lc',
      `set -e; umask 077; mkdir -p "$(dirname "${identityPath}")"; age-keygen -o "${identityPath}" >/dev/null 2>&1`]);
    if (made.status !== 0) throw new Error(`could not create an identity at ${identityPath}: ${made.stderr.trim()}`);
    return { recipient: recipientFor(identityPath), created: true };
  }

  /** The public half, which is safe to put anywhere. */
  function recipientFor(identityPath = DEFAULT_IDENTITY, { missingOk = false } = {}) {
    const result = capture(['bash', '-lc', `age-keygen -y "${identityPath}" 2>/dev/null`]);
    const recipient = result.stdout.trim();
    if (result.status !== 0 || !recipient) {
      if (missingOk) return null;
      throw new Error(`no identity at ${identityPath}; run "suped secrets key" to make one`);
    }
    return assertRecipient(recipient);
  }

  /** Named secrets in, one armoured blob out. Safe to commit. */
  function seal({ secrets, recipient }) {
    requireAge();
    const to = assertRecipient(recipient);
    if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
      throw new Error('secrets must be an object of name to value');
    }
    for (const [name, value] of Object.entries(secrets)) {
      if (typeof value !== 'string') throw new Error(`secret ${name} must be a string`);
    }
    const payload = JSON.stringify({ format: FORMAT, created: now(), secrets });
    const result = capture(['age', '--armor', '--recipient', to], { input: payload });
    if (result.status !== 0) throw new Error(`could not encrypt: ${result.stderr.trim()}`);
    const ciphertext = result.stdout;
    if (!ciphertext.includes('BEGIN AGE ENCRYPTED FILE')) {
      throw new Error('age did not return an encrypted file; refusing to write it');
    }
    // Cheap proof that no secret survived into the output. Only worth doing for
    // values long enough to mean something: a short one occurs in base64 by
    // chance, and a false positive here would block a legitimate seal.
    for (const value of Object.values(secrets)) {
      if (value.length >= 12 && ciphertext.includes(value)) {
        throw new Error('a secret appeared in the ciphertext; refusing to write it');
      }
    }
    return ciphertext;
  }

  /** The blob and an identity back to named secrets. */
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
    catch { throw new Error('the file decrypted but did not contain a secrets payload'); }
    return validateSealed(payload).secrets;
  }

  return { available, ensureIdentity, recipientFor, seal, unseal };
}

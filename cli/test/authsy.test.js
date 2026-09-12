import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthsy, assertRecipient, validateSealed, FORMAT, DEFAULT_IDENTITY } from '../lib/authsy.js';

const RECIPIENT = 'age1sx7zeautvxlhnw3ut6vx0lxzxdxhwszvmrxtc8dwyv4usadf7s3qxjh6c5';
const ARMOR = (body) => `-----BEGIN AGE ENCRYPTED FILE-----\n${body}\n-----END AGE ENCRYPTED FILE-----\n`;

/** A stand-in for age: records what it was asked and round-trips the payload. */
function fixture({ hasAge = true, identity = RECIPIENT, sealFails = false, decryptError = null } = {}) {
  const calls = [];
  let vault = null;
  const capture = (argv, options = {}) => {
    calls.push({ argv, input: options.input });
    if (argv[0] === 'age' && argv[1] === '--version') {
      return { status: hasAge ? 0 : 127, stdout: hasAge ? '1.1.1\n' : '', stderr: '' };
    }
    if (argv[0] === 'age' && argv.includes('--armor')) {
      if (sealFails) return { status: 1, stdout: '', stderr: 'age: error: nope' };
      vault = options.input;
      // Base64 stands in for the real thing: the point is that it is not plaintext.
      return { status: 0, stdout: ARMOR(Buffer.from(options.input).toString('base64')), stderr: '' };
    }
    const script = argv[2] ?? '';
    if (script.includes('age-keygen -y')) {
      return identity
        ? { status: 0, stdout: `${identity}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    }
    if (script.includes('age-keygen -o')) { identity = RECIPIENT; return { status: 0, stdout: '', stderr: '' }; }
    if (script.includes('age --decrypt')) {
      if (decryptError) return { status: 1, stdout: '', stderr: decryptError };
      const body = options.input.split('\n')[1];
      return { status: 0, stdout: Buffer.from(body, 'base64').toString('utf8'), stderr: '' };
    }
    throw new assert.AssertionError({ message: `unexpected command ${JSON.stringify(argv)}` });
  };
  return { authsy: createAuthsy({ capture, now: () => '2026-09-12T00:00:00.000Z' }), calls, vault: () => vault };
}

test('a recipient must actually be an age public key', () => {
  assert.equal(assertRecipient(` ${RECIPIENT} `), RECIPIENT);
  for (const bad of ['', 'nope', 'age1', '$(whoami)', 'age1short', RECIPIENT + '; rm -rf /', null, 42]) {
    assert.throws(() => assertRecipient(bad), /not an age recipient/, `should refuse ${String(bad)}`);
  }
});

test('secrets round-trip through seal and unseal', () => {
  const f = fixture();
  const secrets = { github: 'gho_exampletoken', other: 'second-value' };
  const ciphertext = f.authsy.seal({ secrets, recipient: RECIPIENT });
  assert.match(ciphertext, /BEGIN AGE ENCRYPTED FILE/);
  assert.deepEqual(f.authsy.unseal({ ciphertext }), secrets);
});

test('no secret survives into the ciphertext', () => {
  const f = fixture();
  const ciphertext = f.authsy.seal({ secrets: { github: 'gho_verysecret' }, recipient: RECIPIENT });
  assert.equal(ciphertext.includes('gho_verysecret'), false);
  // And the payload reached age on stdin, not on a command line.
  const sealCall = f.calls.find((call) => call.argv.includes('--armor'));
  assert.ok(sealCall.input.includes('gho_verysecret'), 'payload goes in on stdin');
  assert.equal(sealCall.argv.join(' ').includes('gho_verysecret'), false, 'never on the command line');
});

test('the sealed payload carries a format and a date, not just the secrets', () => {
  const f = fixture();
  f.authsy.seal({ secrets: { a: 'b' }, recipient: RECIPIENT });
  const payload = JSON.parse(f.vault());
  assert.equal(payload.format, FORMAT);
  assert.equal(payload.created, '2026-09-12T00:00:00.000Z');
  assert.deepEqual(payload.secrets, { a: 'b' });
});

test('sealing refuses anything that is not a string secret', () => {
  const f = fixture();
  for (const secrets of [null, [], 'nope', { a: 42 }, { a: null }]) {
    assert.throws(() => f.authsy.seal({ secrets, recipient: RECIPIENT }), /must be (an object|a string)/);
  }
});

test('sealing refuses a recipient that is not a key, before running anything', () => {
  const f = fixture();
  assert.throws(() => f.authsy.seal({ secrets: { a: 'b' }, recipient: 'evil; rm -rf /' }), /not an age recipient/);
  assert.equal(f.calls.some((call) => call.argv.includes('--armor')), false, 'age must not have run');
});

test('missing age is reported before anything else is attempted', () => {
  const f = fixture({ hasAge: false });
  assert.equal(f.authsy.available(), false);
  assert.throws(() => f.authsy.seal({ secrets: { a: 'b' }, recipient: RECIPIENT }), /age is not installed/);
  assert.throws(() => f.authsy.unseal({ ciphertext: ARMOR('x') }), /age is not installed/);
});

test('an identity is created only when there is not one already', () => {
  const missing = fixture({ identity: null });
  assert.deepEqual(missing.authsy.ensureIdentity('/tmp/k'), { recipient: RECIPIENT, created: true });
  assert.ok(missing.calls.some((call) => (call.argv[2] ?? '').includes('age-keygen -o')));

  const present = fixture();
  assert.deepEqual(present.authsy.ensureIdentity('/tmp/k'), { recipient: RECIPIENT, created: false });
  assert.equal(present.calls.some((call) => (call.argv[2] ?? '').includes('age-keygen -o')), false);
});

test('a missing identity is reported plainly, or as null when asked', () => {
  const f = fixture({ identity: null });
  assert.equal(f.authsy.recipientFor('/tmp/k', { missingOk: true }), null);
  assert.throws(() => f.authsy.recipientFor('/tmp/k'), /no identity at \/tmp\/k/);
});

test('the wrong identity gets an explanation, not an age error', () => {
  const f = fixture({ decryptError: 'age: error: no identity matched any of the recipients' });
  assert.throws(
    () => f.authsy.unseal({ ciphertext: ARMOR('x') }),
    /identity does not open that file; copy the identity/,
  );
});

test('unsealing refuses input that is not an encrypted file', () => {
  const f = fixture();
  for (const bad of ['', 'just some text', null, '{"secrets":{}}']) {
    assert.throws(() => f.authsy.unseal({ ciphertext: bad }), /does not look like an age encrypted file/);
  }
});

test('a payload from a newer authsy is refused rather than half-read', () => {
  assert.throws(() => validateSealed({ format: 99, secrets: {} }), /unsupported format 99/);
  assert.throws(() => validateSealed(null), /expected an object/);
  assert.throws(() => validateSealed({ format: FORMAT, secrets: [] }), /secrets must be an object/);
  assert.throws(() => validateSealed({ format: FORMAT, secrets: { a: 42 } }), /secret a must be a string/);
  assert.deepEqual(validateSealed({ format: FORMAT, secrets: { a: 'b' } }).secrets, { a: 'b' });
});

test('the default identity lives in the workspace config, not a repo', () => {
  assert.match(DEFAULT_IDENTITY, /^\$HOME\/\.config\/suped\//);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthsy, assertRecipient, assertId, validateEntry, validateSealed, redactEntry,
  FORMAT, KINDS, STATUSES, DEFAULT_IDENTITY,
} from '../lib/authsy.js';

const RECIPIENT = 'age1sx7zeautvxlhnw3ut6vx0lxzxdxhwszvmrxtc8dwyv4usadf7s3qxjh6c5';
const ARMOR = (body) => `-----BEGIN AGE ENCRYPTED FILE-----\n${body}\n-----END AGE ENCRYPTED FILE-----\n`;

const ACCOUNT = {
  kind: 'account', service: 'resend', url: 'https://resend.com',
  email: 'nick-mail', plus: 'resend', username: 'nick',
  password: 'a-long-enough-password', mfa: 'JBSWY3DPEHPK3PXP',
  recovery: ['aaaa-bbbb-cccc', 'dddd-eeee-ffff'],
  keys: { api: 're_a_long_api_key_value' },
  status: 'active', createdBy: 'agent', created: '2026-09-12T00:00:00.000Z',
};

function fixture({ hasAge = true, identity = RECIPIENT, decryptError = null } = {}) {
  const calls = [];
  let vault = null;
  const capture = (argv, options = {}) => {
    calls.push({ argv, input: options.input });
    if (argv[0] === 'age' && argv[1] === '--version') {
      return { status: hasAge ? 0 : 127, stdout: hasAge ? '1.1.1\n' : '', stderr: '' };
    }
    if (argv[0] === 'age' && argv.includes('--armor')) {
      vault = options.input;
      return { status: 0, stdout: ARMOR(Buffer.from(options.input).toString('base64')), stderr: '' };
    }
    const script = argv[2] ?? '';
    if (script.includes('age-keygen -y')) {
      return identity ? { status: 0, stdout: `${identity}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (script.includes('age-keygen -o')) { identity = RECIPIENT; return { status: 0, stdout: '', stderr: '' }; }
    if (script.includes('age --decrypt')) {
      if (decryptError) return { status: 1, stdout: '', stderr: decryptError };
      return { status: 0, stdout: Buffer.from(options.input.split('\n')[1], 'base64').toString('utf8'), stderr: '' };
    }
    throw new assert.AssertionError({ message: `unexpected command ${JSON.stringify(argv)}` });
  };
  return { authsy: createAuthsy({ capture, now: () => '2026-09-12T00:00:00.000Z' }), calls, vault: () => vault };
}

test('a recipient must actually be an age public key', () => {
  assert.equal(assertRecipient(` ${RECIPIENT} `), RECIPIENT);
  for (const bad of ['', 'nope', 'age1', '$(whoami)', RECIPIENT + '; rm -rf /', null, 42]) {
    assert.throws(() => assertRecipient(bad), /not an age recipient/, `should refuse ${String(bad)}`);
  }
});

test('an id is a safe slug, because it names a file and a shell argument', () => {
  for (const good of ['github', 'nick-mail', 'resend.prod', 'a_b', 'x1']) assert.equal(assertId(good), good);
  for (const bad of ['', 'Uppercase', '-leading', 'has space', '../escape', 'semi;colon', '$(x)', 'a'.repeat(65)]) {
    assert.throws(() => assertId(bad), /not a usable id/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('an account is a record, not a string', () => {
  // The whole point of format 2: a signup leaves more than one secret behind.
  assert.doesNotThrow(() => validateEntry('resend', ACCOUNT));
  assert.deepEqual(KINDS.account.required, ['service']);
  assert.ok(KINDS.account.secret.includes('recovery'), 'recovery codes are secret');
  assert.ok(KINDS.account.secret.includes('mfa'), 'the second factor is secret');
  assert.ok(KINDS.account.secret.includes('keys'), 'issued keys are secret');
});

test('each kind insists on what it cannot work without', () => {
  assert.throws(() => validateEntry('x', { kind: 'token' }), /needs a value/);
  assert.throws(() => validateEntry('x', { kind: 'email' }), /needs a address/);
  assert.throws(() => validateEntry('x', { kind: 'account' }), /needs a service/);
  assert.throws(() => validateEntry('x', { kind: 'mystery', value: 'v' }), /unknown kind/);
  assert.throws(() => validateEntry('x', null), /expected an object/);
});

test('record fields are checked so nothing downstream has to guess', () => {
  assert.throws(() => validateEntry('x', { ...ACCOUNT, recovery: 'not-a-list' }), /recovery must be a list/);
  assert.throws(() => validateEntry('x', { ...ACCOUNT, recovery: [1, 2] }), /recovery must be a list/);
  assert.throws(() => validateEntry('x', { ...ACCOUNT, keys: 'nope' }), /keys must be an object/);
  assert.throws(() => validateEntry('x', { ...ACCOUNT, status: 'maybe' }), /status must be one of/);
  assert.throws(() => validateEntry('x', { ...ACCOUNT, username: 42 }), /username must be a string/);
  assert.throws(() => validateEntry('x', { ...ACCOUNT, needs: [3] }), /needs must be a list/);
  assert.deepEqual(STATUSES, ['active', 'pending']);
});

test('an account waiting on a person is a first-class state, not a missing field', () => {
  const pending = { kind: 'account', service: 'x', status: 'pending', needs: ['password', 'api key'] };
  assert.doesNotThrow(() => validateEntry('x-com', pending));
});

test('showing an entry hides every secret but keeps what identifies it', () => {
  const shown = redactEntry(ACCOUNT);
  assert.equal(shown.service, 'resend');
  assert.equal(shown.email, 'nick-mail');
  assert.equal(shown.username, 'nick');
  assert.equal(shown.password, '••••');
  assert.equal(shown.mfa, '••••');
  assert.deepEqual(shown.recovery, ['••••', '••••']);
  assert.deepEqual(shown.keys, { api: '••••' });
  const serialized = JSON.stringify(shown);
  for (const secret of ['a-long-enough-password', 'JBSWY3DPEHPK3PXP', 'aaaa-bbbb-cccc', 're_a_long_api_key_value']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not survive redaction`);
  }
});

test('a mailbox password is hidden too', () => {
  const email = { kind: 'email', address: 'nick@mcinnis.dev', imap: { host: 'imap.fastmail.com', user: 'nick', password: 'hunter2hunter2' } };
  const shown = redactEntry(email);
  assert.equal(shown.imap.host, 'imap.fastmail.com');
  assert.equal(shown.imap.password, '••••');
});

test('entries round-trip through seal and unseal', () => {
  const f = fixture();
  const entries = { resend: ACCOUNT, github: { kind: 'token', value: 'gho_exampletoken' } };
  const ciphertext = f.authsy.seal({ entries, recipient: RECIPIENT });
  assert.deepEqual(f.authsy.unseal({ ciphertext }), entries);
});

test('nothing secret survives into the ciphertext', () => {
  const f = fixture();
  const ciphertext = f.authsy.seal({ entries: { resend: ACCOUNT }, recipient: RECIPIENT });
  for (const secret of ['a-long-enough-password', 'aaaa-bbbb-cccc', 're_a_long_api_key_value']) {
    assert.equal(ciphertext.includes(secret), false, `${secret} leaked`);
  }
  const sealCall = f.calls.find((call) => call.argv.includes('--armor'));
  assert.ok(sealCall.input.includes('a-long-enough-password'), 'payload goes in on stdin');
  assert.equal(sealCall.argv.join(' ').includes('a-long-enough-password'), false, 'never on the command line');
});

test('sealing refuses a bad entry before running anything', () => {
  const f = fixture();
  assert.throws(() => f.authsy.seal({ entries: { x: { kind: 'nope' } }, recipient: RECIPIENT }), /unknown kind/);
  assert.throws(() => f.authsy.seal({ entries: 'nope', recipient: RECIPIENT }), /entries must be an object/);
  assert.throws(() => f.authsy.seal({ entries: {}, recipient: 'evil; rm -rf /' }), /not an age recipient/);
  assert.equal(f.calls.some((call) => call.argv.includes('--armor')), false, 'age must not have run');
});

test('a format 1 file still opens, read as tokens', () => {
  // Files written before accounts existed must not become unreadable.
  const old = { format: 1, created: 'then', secrets: { github: 'gho_old', neon: 'neon_old' } };
  const upgraded = validateSealed(old);
  assert.equal(upgraded.format, FORMAT);
  assert.deepEqual(upgraded.entries, {
    github: { kind: 'token', value: 'gho_old' },
    neon: { kind: 'token', value: 'neon_old' },
  });
});

test('a payload from a newer authsy is refused rather than half-read', () => {
  assert.throws(() => validateSealed({ format: 99, entries: {} }), /unsupported format 99/);
  assert.throws(() => validateSealed(null), /expected an object/);
  assert.throws(() => validateSealed({ format: FORMAT, entries: [] }), /entries must be an object/);
  assert.throws(() => validateSealed({ format: FORMAT, entries: { x: { kind: 'token' } } }), /needs a value/);
  assert.throws(() => validateSealed({ format: 1, secrets: { a: 42 } }), /secret a must be a string/);
});

test('missing age is reported before anything else is attempted', () => {
  const f = fixture({ hasAge: false });
  assert.equal(f.authsy.available(), false);
  assert.throws(() => f.authsy.seal({ entries: {}, recipient: RECIPIENT }), /age is not installed/);
  assert.throws(() => f.authsy.unseal({ ciphertext: ARMOR('x') }), /age is not installed/);
});

test('an identity is created only when there is not one already', () => {
  const missing = fixture({ identity: null });
  assert.deepEqual(missing.authsy.ensureIdentity('/tmp/k'), { recipient: RECIPIENT, created: true });
  const present = fixture();
  assert.deepEqual(present.authsy.ensureIdentity('/tmp/k'), { recipient: RECIPIENT, created: false });
  assert.equal(present.calls.some((call) => (call.argv[2] ?? '').includes('age-keygen -o')), false);
});

test('the wrong identity gets an explanation, not an age error', () => {
  const f = fixture({ decryptError: 'age: error: no identity matched any of the recipients' });
  assert.throws(() => f.authsy.unseal({ ciphertext: ARMOR('x') }), /identity does not open that file; copy the identity/);
});

test('unsealing refuses input that is not an encrypted file', () => {
  const f = fixture();
  for (const bad of ['', 'just some text', null, '{"entries":{}}']) {
    assert.throws(() => f.authsy.unseal({ ciphertext: bad }), /does not look like an age encrypted file/);
  }
});

test('the default identity lives in the workspace config, not a repo', () => {
  assert.match(DEFAULT_IDENTITY, /^\$HOME\/\.config\/suped\//);
});

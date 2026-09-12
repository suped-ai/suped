import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecrets, portableTools, describeEntry, DEFAULT_STORE } from '../lib/secrets.js';
import { TOOLS } from '../lib/tools.js';

const RECIPIENT = 'age1sx7zeautvxlhnw3ut6vx0lxzxdxhwszvmrxtc8dwyv4usadf7s3qxjh6c5';
const SEALED = (entries) => `-----BEGIN AGE ENCRYPTED FILE-----\n${Buffer.from(JSON.stringify(entries)).toString('base64')}\n-----END AGE ENCRYPTED FILE-----\n`;

const CARRIER = {
  id: 'github', name: 'GitHub', command: 'gh', category: 'source',
  secret: { export: ['gh', 'auth', 'token'], import: ['gh', 'auth', 'login', '--with-token'] },
  afterLogin: ['gh', 'auth', 'setup-git'],
};
const NO_SECRET = { id: 'neon', name: 'Neon', command: 'neon', category: 'database' };

const MAILBOX = { kind: 'email', address: 'nick@mcinnis.dev', label: 'personal' };
const RESEND = {
  kind: 'account', service: 'resend', email: 'nick-mail', plus: 'resend',
  password: 'a-long-enough-password', keys: { api: 're_a_long_api_key' }, status: 'active', createdBy: 'agent',
};
const PENDING = { kind: 'account', service: 'x', status: 'pending', needs: ['password', 'api key'], createdBy: 'agent' };

function fixture({ tools = [CARRIER, NO_SECRET], signedIn = { github: 'gho_realtokenvalue' }, store = {}, stdin = '', importFails = null } = {}) {
  const logs = [];
  const calls = [];
  const written = {};
  let stdout = '';
  let saved = { ...store };

  const capture = (argv, options = {}) => {
    calls.push({ argv, input: options.input });
    const script = argv[2] ?? '';
    if (script.startsWith('cat "')) {
      return Object.keys(saved).length
        ? { status: 0, stdout: SEALED(saved), stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    }
    if (script.includes('cat > "')) {
      saved = JSON.parse(Buffer.from(options.input.split('\n')[1], 'base64').toString('utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    const exporter = tools.find((t) => t.secret && JSON.stringify(t.secret.export) === JSON.stringify(argv));
    if (exporter) {
      const value = signedIn[exporter.id];
      return value ? { status: 0, stdout: `${value}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    const importer = tools.find((t) => t.secret && JSON.stringify(t.secret.import) === JSON.stringify(argv));
    if (importer) {
      return importFails === importer.id
        ? { status: 1, stdout: '', stderr: 'bad credentials\nmore detail' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (JSON.stringify(argv) === JSON.stringify(CARRIER.afterLogin)) return { status: 0, stdout: '', stderr: '' };
    throw new assert.AssertionError({ message: `unexpected command ${JSON.stringify(argv)}` });
  };

  const authsy = {
    available: () => true,
    ensureIdentity: () => ({ recipient: RECIPIENT, created: false }),
    recipientFor: () => RECIPIENT,
    seal: ({ entries }) => SEALED(entries),
    unseal: ({ ciphertext }) => JSON.parse(Buffer.from(ciphertext.split('\n')[1], 'base64').toString('utf8')),
  };

  const instance = createSecrets({
    capture, authsy, tools,
    log: (m) => logs.push(m),
    readFile: (f) => { if (f === 'missing') throw new Error('ENOENT'); return SEALED(store.__incoming ?? {}); },
    writeFile: (f, t) => { written[f] = t; },
    write: (t) => { stdout += t; },
    readStdin: () => stdin,
  });
  return { ...instance, logs, calls, written, stdout: () => stdout, stored: () => saved, text: () => logs.join('\n') };
}

test('only tools that can both export and import a secret are portable', () => {
  assert.deepEqual(portableTools([CARRIER, NO_SECRET]).map((t) => t.id), ['github']);
  assert.ok(portableTools(TOOLS).some((t) => t.id === 'github'));
});

test('the store lives in the home, so it survives a reset', () => {
  assert.match(DEFAULT_STORE, /^\$HOME\/\.config\/suped\//);
});

test('an entry that is waiting on a person says so where it will be seen', () => {
  const line = describeEntry('x-com', PENDING);
  assert.match(line, /WAITING ON YOU/);
  assert.match(line, /password, api key/);
  // An ordinary one does not shout.
  assert.doesNotMatch(describeEntry('resend', RESEND), /WAITING/);
});

test('set takes one entry as JSON on stdin, never on a command line', () => {
  const f = fixture({ stdin: JSON.stringify(MAILBOX) });
  assert.equal(f.set('nick-mail'), 0);
  assert.deepEqual(f.stored()['nick-mail'], MAILBOX);
  assert.match(f.text(), /added nick-mail \(email\)/);
  assert.equal(f.calls.some((c) => c.argv.join(' ').includes('nick@mcinnis.dev')), false);
});

test('set refuses an entry that is not usable, leaving the store alone', () => {
  const bad = fixture({ stdin: JSON.stringify({ kind: 'account' }), store: { resend: RESEND } });
  assert.throws(() => bad.set('broken'), /needs a service/);
  assert.deepEqual(Object.keys(bad.stored()), ['resend']);

  const notJson = fixture({ stdin: 'hello' });
  assert.throws(() => notJson.set('x'), /stdin was not JSON/);

  const empty = fixture({ stdin: '' });
  assert.throws(() => empty.set('x'), /nothing on stdin/);

  const badId = fixture({ stdin: JSON.stringify(MAILBOX) });
  assert.throws(() => badId.set('../escape'), /not a usable id/);
});

test('a pending account is recorded and says nothing can use it yet', () => {
  const f = fixture({ stdin: JSON.stringify(PENDING) });
  assert.equal(f.set('x-com'), 0);
  assert.equal(f.stored()['x-com'].status, 'pending');
  assert.match(f.text(), /Marked pending/);
});

test('finishing a handoff is just replacing the entry', () => {
  const f = fixture({
    store: { 'x-com': PENDING },
    stdin: JSON.stringify({ kind: 'account', service: 'x', status: 'active', password: 'set-by-a-person', createdBy: 'human' }),
  });
  assert.equal(f.set('x-com'), 0);
  assert.equal(f.stored()['x-com'].status, 'active');
  assert.equal(f.stored()['x-com'].createdBy, 'human');
  assert.match(f.text(), /replaced x-com/);
});

test('list shows what is there and surfaces what is waiting', () => {
  const f = fixture({ store: { 'nick-mail': MAILBOX, resend: RESEND, 'x-com': PENDING } });
  assert.equal(f.list(), 0);
  const text = f.text();
  assert.match(text, /3 entries/);
  assert.match(text, /nick-mail\s+email\s+nick@mcinnis\.dev/);
  assert.match(text, /WAITING ON YOU/);
  assert.match(text, /1 account\(s\) are waiting on you/);
});

test('an empty store says so rather than printing nothing', () => {
  const f = fixture();
  assert.equal(f.list(), 0);
  assert.match(f.text(), /store is empty/);
});

test('show hides secrets by default and prints them only when asked', () => {
  const hidden = fixture({ store: { resend: RESEND } });
  hidden.show('resend');
  assert.equal(hidden.stdout().includes('a-long-enough-password'), false);
  assert.match(hidden.stdout(), /••••/);
  assert.match(hidden.text(), /secrets hidden/);

  const shown = fixture({ store: { resend: RESEND } });
  shown.show('resend', { reveal: true });
  assert.match(shown.stdout(), /a-long-enough-password/);
});

test('show and remove complain about an id that is not there', () => {
  const f = fixture({ store: { resend: RESEND } });
  assert.throws(() => f.show('nope'), /no entry nope/);
  assert.throws(() => f.remove('nope'), /no entry nope/);
  assert.throws(() => f.remove(), /usage: suped secrets remove/);
});

test('remove takes one entry out and leaves the rest', () => {
  const f = fixture({ store: { 'nick-mail': MAILBOX, resend: RESEND } });
  assert.equal(f.remove('resend'), 0);
  assert.deepEqual(Object.keys(f.stored()), ['nick-mail']);
});

test('save captures live tool credentials alongside what is already stored', () => {
  const f = fixture({ store: { 'nick-mail': MAILBOX } });
  assert.equal(f.save('/tmp/out.age'), 0);
  assert.deepEqual(Object.keys(f.stored()).sort(), ['github', 'nick-mail']);
  assert.deepEqual(f.stored().github, { kind: 'token', value: 'gho_realtokenvalue' });
  assert.match(f.written['/tmp/out.age'], /BEGIN AGE ENCRYPTED FILE/);
});

test('save with no file just persists the store', () => {
  const f = fixture({ store: { 'nick-mail': MAILBOX } });
  assert.equal(f.save(null), 0);
  assert.equal(Object.keys(f.written).length, 0);
  assert.ok(f.stored()['nick-mail']);
});

test('save says so rather than sealing nothing', () => {
  const f = fixture({ signedIn: {} });
  assert.equal(f.save('/tmp/out.age'), 1);
  assert.equal(Object.keys(f.written).length, 0);
  assert.match(f.text(), /Nothing to seal/);
});

test('restore merges into the store and signs tools in from stdin', () => {
  const f = fixture({ store: { __incoming: { github: { kind: 'token', value: 'gho_fromfile' }, resend: RESEND } } });
  assert.equal(f.restore('/tmp/in.age'), 0);
  const login = f.calls.find((c) => c.argv.includes('--with-token'));
  assert.equal(login.input, 'gho_fromfile\n');
  assert.equal(login.argv.join(' ').includes('gho_fromfile'), false);
  assert.ok(f.calls.some((c) => JSON.stringify(c.argv) === JSON.stringify(CARRIER.afterLogin)));
  assert.match(f.text(), /merged 2 entries/);
  assert.match(f.text(), /GitHub: signed in/);
  // An account is stored, not "signed in" -- there is nothing to sign in to.
  assert.ok(f.stored().resend);
});

test('restore carries a pending account across and says it is still waiting', () => {
  const f = fixture({ store: { __incoming: { 'x-com': PENDING } } });
  assert.equal(f.restore('/tmp/in.age'), 0);
  assert.equal(f.stored()['x-com'].status, 'pending');
  assert.match(f.text(), /1 account\(s\) came across still waiting on a person/);
});

test('restore reports a rejected credential and points at login', () => {
  const f = fixture({ store: { __incoming: { github: { kind: 'token', value: 'stale' } } }, importFails: 'github' });
  assert.equal(f.restore('/tmp/in.age'), 1);
  assert.match(f.text(), /could not sign in; run "suped login github"/);
  assert.equal(f.text().includes('more detail'), false);
});

test('restore needs a file that exists', () => {
  const f = fixture();
  assert.throws(() => f.restore(), /usage: suped secrets restore/);
  assert.throws(() => f.restore('missing'), /could not read missing/);
});

test('status reports the store, the identity, and anything waiting', () => {
  const f = fixture({ store: { 'nick-mail': MAILBOX, 'x-com': PENDING } });
  assert.equal(f.status(), 0);
  const text = f.text();
  assert.match(text, /identity\s+\$HOME/);
  assert.match(text, /entries\s+0 token, 1 email, 1 account/);
  assert.match(text, /GitHub\s+signed in; will travel/);
  assert.match(text, /1 account\(s\) waiting on you/);
  assert.match(text, /identity is not/);
});

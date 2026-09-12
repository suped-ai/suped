import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecrets, portableTools } from '../lib/secrets.js';
import { TOOLS } from '../lib/tools.js';

const RECIPIENT = 'age1sx7zeautvxlhnw3ut6vx0lxzxdxhwszvmrxtc8dwyv4usadf7s3qxjh6c5';

const CARRIER = {
  id: 'github', name: 'GitHub', command: 'gh', category: 'source',
  secret: { export: ['gh', 'auth', 'token'], import: ['gh', 'auth', 'login', '--with-token'] },
  afterLogin: ['gh', 'auth', 'setup-git'],
};
const NO_SECRET = { id: 'neon', name: 'Neon', command: 'neon', category: 'database' };

function fixture({ tools = [CARRIER, NO_SECRET], signedIn = { github: 'gho_realtokenvalue' }, importFails = null, sealed = null } = {}) {
  const logs = [];
  const calls = [];
  const written = {};
  let stdout = '';
  let vault = null;

  const capture = (argv, options = {}) => {
    calls.push({ argv, input: options.input });
    const tool = tools.find((entry) => entry.secret && JSON.stringify(entry.secret.export) === JSON.stringify(argv));
    if (tool) {
      const value = signedIn[tool.id];
      return value ? { status: 0, stdout: `${value}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'not logged in' };
    }
    const importing = tools.find((entry) => entry.secret && JSON.stringify(entry.secret.import) === JSON.stringify(argv));
    if (importing) {
      return importFails === importing.id
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
    seal: ({ secrets, recipient }) => {
      assert.equal(recipient, RECIPIENT);
      vault = secrets;
      return '-----BEGIN AGE ENCRYPTED FILE-----\nopaque\n-----END AGE ENCRYPTED FILE-----\n';
    },
    unseal: () => sealed ?? {},
  };

  const instance = createSecrets({
    capture, authsy, tools,
    log: (message) => logs.push(message),
    readFile: (file) => { if (file === 'missing') throw new Error('ENOENT'); return 'ciphertext'; },
    writeFile: (file, text) => { written[file] = text; },
    write: (text) => { stdout += text; },
  });
  return { ...instance, logs, calls, written, vault: () => vault, stdout: () => stdout, text: () => logs.join('\n') };
}

test('only tools that can both export and import a secret are portable', () => {
  assert.deepEqual(portableTools([CARRIER, NO_SECRET]).map((t) => t.id), ['github']);
  assert.deepEqual(portableTools([{ id: 'half', secret: { export: ['x'] } }]), []);
  assert.deepEqual(portableTools([{ id: 'none' }]), []);
});

test('GitHub is wired up in the real catalogue, and uses stdin both ways', () => {
  const carriers = portableTools(TOOLS);
  assert.ok(carriers.some((tool) => tool.id === 'github'), 'github should be able to hand its token over');
  const github = carriers.find((tool) => tool.id === 'github');
  assert.deepEqual(github.secret.export, ['gh', 'auth', 'token', '--hostname', 'github.com']);
  // --with-token makes gh read the token from stdin rather than an argument.
  assert.ok(github.secret.import.includes('--with-token'));
});

test('status separates what travels from what has to be done again', () => {
  const f = fixture();
  assert.equal(f.status(), 0);
  const text = f.text();
  assert.match(text, /GitHub\s+signed in; will travel/);
  assert.match(text, /1 other tool\(s\) re-authenticate/);
  assert.match(text, /The sealed file is safe to commit/);
  assert.match(text, /identity is not/);
});

test('a tool that is not signed in has nothing to carry', () => {
  const f = fixture({ signedIn: {} });
  f.status();
  assert.match(f.text(), /GitHub\s+not signed in; nothing to carry/);
});

test('save seals exactly the credentials that are signed in', () => {
  const f = fixture();
  assert.equal(f.save('/tmp/secrets.age'), 0);
  assert.deepEqual(f.vault(), { github: 'gho_realtokenvalue' });
  assert.match(f.written['/tmp/secrets.age'], /BEGIN AGE ENCRYPTED FILE/);
  assert.match(f.text(), /sealed 1 credential\(s\): github/);
});

test('save writes to stdout for "-"', () => {
  const f = fixture();
  assert.equal(f.save('-'), 0);
  assert.match(f.stdout(), /BEGIN AGE ENCRYPTED FILE/);
  assert.equal(Object.keys(f.written).length, 0);
});

test('save says so rather than writing an empty vault', () => {
  const f = fixture({ signedIn: {} });
  assert.equal(f.save('/tmp/s.age'), 1);
  assert.equal(Object.keys(f.written).length, 0);
  assert.match(f.text(), /Nothing to seal/);
});

test('restore signs each tool in with the secret on stdin, never on a command line', () => {
  const f = fixture({ sealed: { github: 'gho_realtokenvalue' } });
  assert.equal(f.restore('/tmp/s.age'), 0);
  const login = f.calls.find((call) => call.argv.includes('--with-token'));
  assert.equal(login.input, 'gho_realtokenvalue\n');
  assert.equal(login.argv.join(' ').includes('gho_realtokenvalue'), false);
  // afterLogin still runs, so git credentials get set up too.
  assert.ok(f.calls.some((call) => JSON.stringify(call.argv) === JSON.stringify(CARRIER.afterLogin)));
  assert.match(f.text(), /GitHub: signed in/);
});

test('restore skips a secret this Suped has no tool for', () => {
  const f = fixture({ sealed: { github: 'gho_realtokenvalue', fromfuture: 'x' } });
  assert.equal(f.restore('/tmp/s.age'), 0);
  assert.match(f.text(), /skipped fromfuture \(this Suped has no tool that can take it\)/);
  assert.match(f.text(), /Restored 1 credential/);
});

test('restore reports a rejected credential and points at login', () => {
  const f = fixture({ sealed: { github: 'stale-token' }, importFails: 'github' });
  assert.equal(f.restore('/tmp/s.age'), 1);
  assert.match(f.text(), /GitHub: could not sign in; run "suped login github"/);
  // Only the first line of the provider's complaint, not a wall of stderr.
  assert.equal(f.text().includes('more detail'), false);
});

test('restore needs a file that exists', () => {
  const f = fixture();
  assert.throws(() => f.restore(), /usage: suped secrets restore/);
  assert.throws(() => f.restore('missing'), /could not read missing/);
});

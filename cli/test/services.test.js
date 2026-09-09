import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SERVICE_TOOLS } from '../lib/catalog/services.js';
import { shellQuote } from '../lib/catalog/installers.js';

const byId = Object.fromEntries(SERVICE_TOOLS.map((tool) => [tool.id, tool]));
const result = (value, status = 0) => ({ status, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });

test('service connection checks reject logged-out output, invalid JSON, and failed requests', () => {
  for (const tool of SERVICE_TOOLS) {
    for (const response of [undefined, result(''), result('You are not logged in. Please login.'), result({ error: 'unauthorized' }), result('[]', 1)]) {
      assert.equal(tool.connected(response), false, `${tool.id}: ${JSON.stringify(response)}`);
    }
  }
});

test('Neon checks actual project access, including an empty account, without starting OAuth', () => {
  assert.equal(byId.neon.connected(result({ projects: [] })), true);
  assert.equal(byId.neon.connected(result({ projects: [{ id: 'example' }] })), true);
  assert.equal(byId.neon.connected(result({ projects: [] }, 1)), false);
  assert.equal(byId.neon.connected(result({ projects: '[]' })), false);
  assert.deepEqual(byId.neon.check, ['env', 'CI=1', 'neon', 'api', '/projects', '--output', 'json']);
});

test('Turso login URL alone is manual setup, and its exit-zero logged-out message is not connected', () => {
  assert.equal(byId.turso.login, null);
  assert.equal(byId.turso.connected(result('agent-workspace\n')), true);
  assert.equal(byId.turso.connected(result('agent-workspace\n', 1)), false);
  assert.equal(byId.turso.connected(result('You are not logged in, please login with turso auth login before running other commands.\n')), false);
  assert.equal(byId.turso.connected(result('Error: token is expired\n')), false);
});

test('PlanetScale requires authenticated and ready status', () => {
  assert.equal(byId.planetscale.connected(result({ status: 'ok', authenticated: true, organization: 'example' })), true);
  for (const value of [{ status: 'ok', authenticated: false }, { status: 'ok', authenticated: 'true' }, { status: 'action_required', authenticated: true }, { authenticated: true }]) {
    assert.equal(byId.planetscale.connected(result(value)), false);
  }
});

test('Firebase and DigitalOcean require their own successful account response shapes', () => {
  assert.equal(byId.firebase.connected(result({ status: 'success', result: [] })), true);
  assert.equal(byId.firebase.connected(result({ status: 'success', result: {} })), false);
  assert.equal(byId.firebase.connected(result({ status: 'error', result: [] })), false);
  assert.equal(byId.digitalocean.connected(result({ uuid: 'account-id', email: 'person@example.test' })), true);
  assert.equal(byId.digitalocean.connected(result({ uuid: '', email: 'person@example.test' })), false);
  assert.equal(byId.digitalocean.connected(result({ uuid: 'account-id', email: '' })), false);
});

test('Stripe checks an account resource, not a login URL or arbitrary success', () => {
  assert.equal(byId.stripe.connected(result({ id: 'acct_example123', object: 'account' })), true);
  for (const value of [{ id: 'acct_example123', object: 'customer' }, { id: 'cus_example123', object: 'account' }, { browser_url: 'https://dashboard.stripe.com/example', next_step: 'stripe login --complete-device' }]) {
    assert.equal(byId.stripe.connected(result(value)), false);
  }
});

const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--noprofile', '--norc', '-c', 'exit 0'], { windowsHide: true }).status === 0;

// Only a shell function pretending to be the native CLI executes. No account,
// network, home directory, secret file, or real provider command is touched.
function runNeonPrompt({ input = 'fake-test-token\n', connected = false, status = 0, profile = '', apiKey = '', trace = false } = {}) {
  const nativeShim = `
neon() {
  if [ "$1" = api ]; then return ${connected ? 0 : 1}; fi
  [ "$#" = 5 ] && [ "$1" = profile ] && [ "$2" = create ] && [ "$3" = "\${NEON_PROFILE:-DEFAULT}" ] && [ "$4" = --api-key ] && [ "$5" = - ] || return 91
  local received
  received=$(cat)
  [ "$received" = "$SUPED_TEST_INPUT" ] || return 92
  printf 'NATIVE_RECEIVED_STDIN\\n'
  return ${status}
}
`;
  const script = nativeShim + byId.neon.login.at(-1);
  return spawnSync(bash, ['--noprofile', '--norc', ...(trace ? ['-x'] : []), '-c', script], {
    input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NEON_PROFILE: profile, NEON_API_KEY: apiKey, SUPED_TEST_INPUT: input.trimEnd() },
  });
}

test('Neon masked input goes only through native CLI stdin and is never expanded or logged', { skip: !bashAvailable }, () => {
  const fakeSecret = 'fake-test-$(echo SHOULD_NOT_RUN)-`echo ALSO_NOT_RUN`-value';
  const run = runNeonPrompt({ input: `${fakeSecret}\n`, trace: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /NATIVE_RECEIVED_STDIN/);
  assert.doesNotMatch(run.stdout + run.stderr, /SHOULD_NOT_RUN|ALSO_NOT_RUN|fake-test-/);
  assert.match(run.stderr, /hidden/);
});

test('Neon cancellation and invalid exported credentials leave stored profiles untouched', { skip: !bashAvailable }, () => {
  for (const options of [{ input: '' }, { input: '\n' }, { input: '  \t\n' }, { apiKey: 'fake-invalid-environment-key' }]) {
    const run = runNeonPrompt(options);
    assert.equal(run.status, 1, run.stderr);
    assert.doesNotMatch(run.stdout, /NATIVE_RECEIVED_STDIN/);
  }
});

test('Neon preserves an existing working profile and uses the selected profile when reconnecting', { skip: !bashAvailable }, () => {
  const existing = runNeonPrompt({ connected: true });
  assert.equal(existing.status, 0, existing.stderr);
  assert.match(existing.stdout, /Existing credentials were kept/);
  assert.doesNotMatch(existing.stdout, /NATIVE_RECEIVED_STDIN/);
  const named = runNeonPrompt({ profile: 'work' });
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /active profile \(work\)/);
  const failed = runNeonPrompt({ status: 23 });
  assert.equal(failed.status, 23, failed.stderr);
});

test('DigitalOcean recognizes its verified release banner without accepting another version', { skip: !bashAvailable }, () => {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, 'suped-doctl-version-test-'));
  const prefix = directory.replaceAll('\\', '/');
  mkdirSync(join(directory, 'bin'));
  try {
    for (const [banner, expectedStatus] of [
      ['doctl version 1.168.0-release\nGit commit hash: c775700e', 0],
      ['doctl version 1.168.0-release', 0],
      ['doctl version 1.167.0-release\nGit commit hash: prior', 23],
      ['doctl version 1.168.0-release-candidate', 23],
      ['doctl version 1.168.01-release', 23],
    ]) {
      writeFileSync(join(directory, 'bin/doctl'), `#!/bin/bash\nprintf '%s\\n' ${shellQuote(banner)}\n`, { mode: 0o755 });
      const script = `
mkdir() { return 0; }
mktemp() { printf '%s\\n' "$prefix/stage"; }
rm() { return 0; }
uname() { printf '%s\\n' x86_64; }
curl() { printf 'DOWNLOAD_REQUESTED\\n' >&2; return 23; }
${byId.digitalocean.install.replace("prefix='/home/suped/.local'", `prefix=${shellQuote(prefix)}`)}
`;
      const run = spawnSync(bash, ['--noprofile', '--norc', '-s'], { input: script, encoding: 'utf8', windowsHide: true });
      assert.equal(run.status, expectedStatus, run.stderr);
      if (expectedStatus === 0) assert.doesNotMatch(run.stderr, /DOWNLOAD_REQUESTED/);
      else assert.match(run.stderr, /DOWNLOAD_REQUESTED/);
    }
  } finally {
    const child = relative(parent, resolve(directory));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    rmSync(directory, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { getTools } from '../lib/tools.js';

const github = getTools(['github'])[0];
const cloudflare = getTools(['cloudflare'])[0];
const supabase = getTools(['supabase'])[0];
const result = (stdout, status = 0) => ({ status, stdout, stderr: '' });

test('tool aliases deduplicate while retaining selection order', () => {
  assert.deepEqual(getTools(['Wrangler', 'gh', 'github', 'supabase', 'cloudflare']).map((tool) => tool.id), ['cloudflare', 'github', 'supabase']);
  assert.deepEqual(getTools('github, supabase').map((tool) => tool.id), ['github', 'supabase']);
  assert.deepEqual(getTools([]), []);
});

test('invalid selections fail before a caller can execute any tool', () => {
  const executed = [];
  assert.throws(() => {
    for (const tool of getTools(['github', 'not-a-tool'])) executed.push(tool.id);
  }, /Unknown tool/);
  assert.deepEqual(executed, []);
  for (const selection of [['github', ''], ['github', 'constructor'], ['gh; echo bad'], [null], 123]) {
    assert.throws(() => getTools(selection));
  }
});

test('GitHub connection requires a successful authenticated user response', () => {
  assert.equal(github.connected(result('{"id":123,"login":"octocat"}')), true);
  for (const response of [
    result('{"message":"Bad credentials"}', 1),
    result('{"message":"Bad credentials"}'),
    result('{"id":123,"login":"octocat"}', 1),
    result('{"id":123,"login":""}'),
    result('{"id":"123","login":"octocat"}'),
    result('You are not logged into any GitHub hosts.'),
    result(''),
    undefined,
  ]) assert.equal(github.connected(response), false);
});

test('Wrangler exit zero alone never marks an unauthenticated account connected', () => {
  assert.equal(cloudflare.connected(result('{"loggedIn":true,"authType":"OAuth Token","accounts":[]}')), true);
  for (const response of [
    result('You are not authenticated. Please run `wrangler login`.'),
    result('{"loggedIn":false}'),
    result('{"loggedIn":"true"}'),
    result('{"loggedIn":true}', 1),
    result('{}'),
    result(''),
    undefined,
  ]) assert.equal(cloudflare.connected(response), false);
});

test('Supabase accepts an authenticated account with no projects', () => {
  assert.equal(supabase.connected(result('[]')), true);
  assert.equal(supabase.connected(result('[{"id":"project-ref","name":"Example"}]')), true);
  for (const response of [result('[]', 1), result('{"message":"Unauthorized"}'), result('Access token not provided.'), result(''), undefined]) {
    assert.equal(supabase.connected(response), false);
  }
});

// These tests execute the actual Bash recipes with failing external commands.
// No installer, network request, login, or host home directory is touched.
const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bash, ['--noprofile', '--norc', '-c', 'exit 0'], { windowsHide: true }).status === 0;

function withSandbox(fn) {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, 'suped-tools-test-'));
  try {
    return fn(directory.replaceAll('\\', '/'));
  } finally {
    const child = relative(parent, resolve(directory));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'test cleanup must stay in its temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

function executeRecipe(tool, { fail = 'curl', arch = 'x86_64', prefix } = {}) {
  // Shell function shims make every external write or download inert. Bash's
  // errexit and pipefail still decide whether subsequent recipe steps execute.
  const shims = ['mkdir', 'rm', 'curl', 'sha256sum', 'tar', 'install', 'npm', 'ln', 'mv'].map((command) => `
${command}() {
  printf 'CALLED:${command} %s\\n' "$*" >&2
  ${command === fail ? 'return 23' : 'return 0'}
}`).join('\n');
  const script = `
${shims}
uname() { printf '%s\\n' '${arch}'; }
mktemp() { printf '%s\\n' "$prefix/stage"; }
${tool.install.replace("prefix='/home/suped/.local'", `prefix='${prefix.replaceAll("'", "'\\''")}'`)}
`;
  return spawnSync(bash, ['--noprofile', '--norc', '-s'], { input: script, encoding: 'utf8', windowsHide: true });
}

test('binary recipes stop before extraction if download or checksum verification fails', { skip: !bashAvailable }, () => {
  withSandbox((prefix) => {
    for (const tool of [github, supabase]) {
      for (const fail of ['curl', 'sha256sum']) {
        const run = executeRecipe(tool, { fail, prefix });
        assert.equal(run.status, 23, run.stderr);
        assert.doesNotMatch(run.stderr, /CALLED:(tar|install|mv) /);
        assert.match(run.stderr, /CALLED:rm /, 'failed download must clean its staging directory');
      }
    }
  });
});

test('binary recipes choose the matching Linux release for both supported architectures', { skip: !bashAvailable }, () => {
  withSandbox((prefix) => {
    for (const tool of [github, supabase]) {
      for (const [arch, assetArch] of [['x86_64', 'amd64'], ['aarch64', 'arm64']]) {
        const run = executeRecipe(tool, { arch, prefix });
        assert.equal(run.status, 23, run.stderr);
        assert.match(run.stderr, new RegExp(`https://github.com/.+/releases/download/v[0-9.]+/.+_linux_${assetArch}\\.tar\\.gz`));
      }
      const unsupported = executeRecipe(tool, { arch: 'riscv64', prefix });
      assert.equal(unsupported.status, 1, unsupported.stderr);
      assert.match(unsupported.stderr, /Unsupported CPU architecture/);
      assert.doesNotMatch(unsupported.stderr, /CALLED:curl /);
    }
  });
});

test('extraction and file installation failures never replace the active binary', { skip: !bashAvailable }, () => {
  withSandbox((prefix) => {
    for (const tool of [github, supabase]) {
      for (const fail of ['tar', 'install']) {
        const run = executeRecipe(tool, { fail, prefix });
        assert.equal(run.status, 23, run.stderr);
        assert.doesNotMatch(run.stderr, /CALLED:mv /);
        assert.match(run.stderr, /CALLED:rm /);
      }
    }
  });
});

test('a failed npm install cannot activate a broken Wrangler executable', { skip: !bashAvailable }, () => {
  withSandbox((prefix) => {
    const run = executeRecipe(cloudflare, { fail: 'npm', prefix });
    assert.equal(run.status, 23, run.stderr);
    assert.match(run.stderr, /CALLED:npm .*wrangler@4\.119\.0/);
    assert.doesNotMatch(run.stderr, /CALLED:(ln|mv) /);
    assert.match(run.stderr, /CALLED:rm /);
  });
});

test('already installed pinned versions skip downloads and npm', { skip: !bashAvailable }, () => {
  withSandbox((prefix) => {
    mkdirSync(join(prefix, 'bin'));
    for (const [tool, version] of [[github, 'gh version 2.100.0 (2026-09-03)'], [supabase, '2.117.0'], [cloudflare, '4.119.0']]) {
      writeFileSync(join(prefix, 'bin', tool.command), `#!/bin/bash\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
      const run = executeRecipe(tool, { prefix });
      assert.equal(run.status, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /CALLED:/, 'a current installation must not be modified');
    }
  });
});

test('a different installed version does not bypass the pinned installer', { skip: !bashAvailable }, () => {
  withSandbox((prefix) => {
    mkdirSync(join(prefix, 'bin'));
    for (const tool of [github, supabase, cloudflare]) {
      writeFileSync(join(prefix, 'bin', tool.command), "#!/bin/bash\nprintf '%s\\n' '0.0.1'\n", { mode: 0o755 });
      const run = executeRecipe(tool, { prefix, fail: tool === cloudflare ? 'npm' : 'curl' });
      assert.equal(run.status, 23, run.stderr);
      assert.match(run.stderr, /CALLED:(curl|npm) /);
      assert.doesNotMatch(run.stderr, /CALLED:mv /);
    }
  });
});

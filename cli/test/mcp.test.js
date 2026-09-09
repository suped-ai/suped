import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcp, parseMcpArgs, exportMcpConfig, chooseMcp, READ_CLAUDE_SERVERS, REGISTER_CODEX_SERVERS } from '../lib/mcp.js';
import { MCP_SERVERS, getMcpServers } from '../lib/catalog/mcp.js';
import { createSetup } from '../lib/setup.js';
import { TOOLS } from '../lib/tools.js';

function fixture({ installed = true, configured = [], corrupt = false, failedAdd = false } = {}) {
  const calls = [], output = [];
  const mcp = createMcp({
    ensureUp: (options) => calls.push(['ensureUp', options]),
    log: (message) => output.push(message),
    write: (message) => output.push(message),
    capture: (command, options) => {
      calls.push([command, options]);
      if (command[1] === '--version') return { status: installed ? 0 : 127 };
      if (command[0] === 'node') return { status: 0, stdout: corrupt ? 'broken config' : JSON.stringify(configured) };
      if (command[0] === 'python3') {
        const servers = JSON.parse(options.input);
        return { status: 0, stdout: JSON.stringify({ added: servers.filter((server) => !configured.includes(server.id)).map((server) => server.id), existing: servers.filter((server) => configured.includes(server.id)).map((server) => server.id) }) };
      }
      return { status: failedAdd ? 1 : 0, stdout: 'PRIVATE CLIENT OUTPUT', stderr: 'PRIVATE CLIENT ERROR' };
    },
  });
  return { ...mcp, calls, output };
}

test('MCP requests preserve client values, deduplicate choices, and validate the entire selection', () => {
  assert.deepEqual(parseMcpArgs(['add', 'Notion', 'notion', '--client=claude']).servers.map((server) => server.id), ['notion']);
  assert.equal(parseMcpArgs(['export', '--client', 'codex', 'linear']).client, 'codex');
  for (const args of [ ['add', 'notion'], ['add', 'notion', '--client'], ['add', 'notion', '--client', 'claude', '--client', 'codex'], ['add', 'notion', '--client', 'cursor'], ['add', 'notion', 'unknown', '--client', 'claude'], ['export', '--client', 'claude'], ['list', 'notion'], ['add', 'notion', '--token=secret', '--client', 'claude'] ]) assert.throws(() => parseMcpArgs(args));
});

test('catalogue endpoints are HTTPS, unique, and attributed to documentation', () => {
  assert.equal(new Set(MCP_SERVERS.map((server) => server.id)).size, MCP_SERVERS.length);
  for (const server of MCP_SERVERS) {
    assert.match(server.id, /^[a-z][a-z0-9-]+$/);
    assert.equal(new URL(server.url).protocol, 'https:');
    assert.equal(new URL(server.docs).protocol, 'https:');
  }
});

test('list, help, export, and invalid requests never access Docker', async () => {
  const f = fixture();
  assert.equal(await f.mainMcp(['list']), 0);
  assert.equal(await f.mainMcp(['--help']), 0);
  assert.equal(await f.mainMcp(['add', '--help']), 0);
  assert.equal(await f.mainMcp(['export', 'neon', '--client', 'cursor']), 0);
  await assert.rejects(f.mainMcp(['add', 'notion', 'unknown', '--client', 'claude']), /unknown MCP server/);
  assert.equal(f.calls.length, 0);
});

test('real CLI forwards MCP client options and exports without Docker on PATH', () => {
  const bin = fileURLToPath(new URL('../bin/suped.js', import.meta.url));
  const env = { ...process.env, PATH: '' };
  const result = spawnSync(process.execPath, [bin, '-p', '3000:3000', 'mcp', 'export', 'notion', '--client=cursor'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mcpServers.notion.url, 'https://mcp.notion.com/mcp');
  const help = spawnSync(process.execPath, [bin, 'mcp', 'add', '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /suped mcp add/);
});

test('export emits client-compatible JSON or TOML without credential placeholders', () => {
  const servers = getMcpServers(['notion', 'vercel']);
  const claude = JSON.parse(exportMcpConfig(servers, 'claude'));
  assert.deepEqual(claude.mcpServers.notion, { type: 'http', url: 'https://mcp.notion.com/mcp' });
  assert.deepEqual(JSON.parse(exportMcpConfig(servers, 'cursor')).mcpServers.vercel, { url: 'https://mcp.vercel.com' });
  assert.match(exportMcpConfig(servers, 'codex'), /\[mcp_servers\."notion"\]\nurl = "https:\/\/mcp.notion.com\/mcp"/);
  assert.doesNotMatch(exportMcpConfig(servers, 'codex'), /token|secret|auth/i);
});

test('add requires an installed client before registering any servers', async () => {
  const f = fixture({ installed: false });
  await assert.rejects(f.mainMcp(['add', 'notion', '--client', 'claude']), /suped setup claude/);
  assert.equal(f.calls.length, 2);
});

test('Claude registration uses user scope inside workspace and keeps duplicate entries', async () => {
  const f = fixture({ configured: ['notion'] });
  assert.equal(await f.mainMcp(['add', 'notion', 'linear', '--client', 'claude'], { runArgs: ['-p', '3000:3000'] }), 0);
  const additions = f.calls.filter(([command]) => Array.isArray(command) && command[0] === 'claude' && command[1] === 'mcp');
  assert.deepEqual(additions.map(([command]) => command), [['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'linear', 'https://mcp.linear.app/mcp']]);
  assert.deepEqual(f.calls[0][1].runArgs, ['-p', '3000:3000']);
  assert.ok(f.output.some((line) => line.includes('existing client configuration kept')));
  assert.ok(f.output.some((line) => line.includes('account access has not been verified')));
  assert.equal(f.output.some((line) => line.includes('PRIVATE')), false);
});

test('malformed Claude configuration stops before any registration', async () => {
  const f = fixture({ corrupt: true });
  await assert.rejects(f.mainMcp(['add', 'notion', '--client', 'claude']), /could not read Claude/);
  assert.equal(f.calls.some(([command]) => Array.isArray(command) && command[1] === 'mcp'), false);
});

test('registration failure returns failure and never claims the server was registered', async () => {
  const f = fixture({ failedAdd: true });
  assert.equal(await f.mainMcp(['add', 'notion', '--client', 'claude']), 1);
  assert.ok(f.output.some((line) => line.includes('registration failed')));
  assert.equal(f.output.some((line) => line.includes('registered for')), false);
});

test('Codex registration sends only server metadata over stdin and leaves OAuth explicit', async () => {
  const f = fixture({ configured: ['notion'] });
  assert.equal(await f.mainMcp(['add', 'notion', 'linear', '--client', 'codex']), 0);
  const call = f.calls.find(([command]) => Array.isArray(command) && command[0] === 'python3');
  assert.deepEqual(JSON.parse(call[1].input), [{ id: 'notion', url: 'https://mcp.notion.com/mcp' }, { id: 'linear', url: 'https://mcp.linear.app/mcp' }]);
  assert.equal(f.calls.some(([command]) => Array.isArray(command) && command[1] === 'mcp'), false);
  assert.ok(f.output.includes('  suped exec codex mcp login linear'));
});

test('guided MCP selection defaults to skip and does nothing without a supported client', async () => {
  const register = () => assert.fail('registration was not requested');
  assert.equal(await chooseMcp({ clients: [], ask: () => assert.fail('unexpected question'), register }), 0);
  assert.equal(await chooseMcp({ clients: ['claude'], ask: async () => '', register, log: () => {} }), 0);
});

test('guided MCP selection validates server and client choices before registering', async () => {
  const answers = ['unknown', '1,linear', 'unknown', '2'];
  const calls = [];
  const status = await chooseMcp({ clients: ['claude', 'codex'], ask: async () => answers.shift(), register: async (args) => { calls.push(args); return 1; }, log: () => {} });
  assert.equal(status, 1);
  assert.equal(answers.length, 0);
  assert.deepEqual(calls, [['add', 'notion', 'linear', '--client', 'codex']]);
});

test('setup offers MCP only after guided authenticated setup and only for successfully installed agent clients', async () => {
  async function run({ explicit = false, authenticate = true, fail = false } = {}) {
    const answers = explicit ? ['n'] : ['3', 'claude', ...(authenticate && !fail ? ['n'] : [])];
    const requested = [];
    const setup = createSetup({
      isInteractive: () => true,
      ask: async () => { assert.ok(answers.length, 'unexpected question'); return answers.shift(); },
      log: () => {},
      configureMcp: async ({ clients }) => { requested.push(clients); return 0; },
      capture: (command, options = {}) => {
        if (command[0] === 'node') return { status: 0, stdout: options.input === undefined ? 'null' : '' };
        if (command[0] === 'claude') return { status: 0, stdout: '2.1.266' };
        throw new Error(`unexpected command ${command}`);
      },
      run: (command) => {
        assert.equal(command[2], TOOLS.find((tool) => tool.id === 'claude').install);
        return fail ? 1 : 0;
      },
    });
    const status = await setup.setup({ tools: explicit ? ['claude'] : null, authenticate });
    assert.equal(status, fail ? 1 : 0);
    assert.equal(answers.length, 0);
    return requested;
  }
  assert.deepEqual(await run(), [['claude']]);
  assert.deepEqual(await run({ explicit: true }), []);
  assert.deepEqual(await run({ authenticate: false }), []);
  assert.deepEqual(await run({ fail: true }), []);
});

test('Claude config inspection reads user and project names without exposing credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'suped-mcp-'));
  try {
    writeFileSync(join(directory, '.claude.json'), JSON.stringify({ mcpServers: { private: { headers: { Authorization: 'secret' } } }, projects: { '/project': { mcpServers: { existing: {} } } } }));
    writeFileSync(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { local: {} } }));
    const result = spawnSync(process.execPath, ['-e', READ_CLAUDE_SERVERS], { cwd: directory, env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['private', 'existing', 'local']);
    assert.doesNotMatch(result.stdout, /secret|Authorization/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Claude default config is directly under the home directory when no override is set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'suped-mcp-'));
  try {
    writeFileSync(join(directory, '.claude.json'), JSON.stringify({ mcpServers: { default_home: {} } }));
    mkdirSync(join(directory, '.claude'));
    writeFileSync(join(directory, '.claude', '.claude.json'), JSON.stringify({ mcpServers: { wrong_location: {} } }));
    const result = spawnSync(process.execPath, ['-e', READ_CLAUDE_SERVERS], { cwd: directory, env: { ...process.env, HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['default_home']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Python 3.11+ is part of the Ubuntu 24.04 workspace. Set SUPED_TEST_PYTHON
// when running these preservation tests on a host without python3 on PATH.
const python = process.env.SUPED_TEST_PYTHON || 'python3';
const hasPython = spawnSync(python, ['-c', 'import tomllib'], { stdio: 'ignore' }).status === 0;
function runWriter(directory, servers) {
  return spawnSync(python, ['-c', REGISTER_CODEX_SERVERS], { env: { ...process.env, CODEX_HOME: directory }, input: JSON.stringify(servers), encoding: 'utf8' });
}

test('Codex default registration goes into the persistent user home when CODEX_HOME is unset', { skip: !hasPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'suped-mcp-'));
  try {
    const result = spawnSync(python, ['-c', REGISTER_CODEX_SERVERS], { env: { ...process.env, HOME: directory, USERPROFILE: directory, CODEX_HOME: '' }, input: JSON.stringify(getMcpServers(['notion'])), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(directory, '.codex', 'config.toml'), 'utf8'), /https:\/\/mcp.notion.com\/mcp/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Codex writer preserves comments, existing credentials and settings, and retries without duplicates', { skip: !hasPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'suped-mcp-'));
  try {
    const file = join(directory, 'config.toml');
    const original = '# keep this comment\nmodel = "my-model"\n[mcp_servers.notion]\nurl = "https://existing.example/mcp"\nbearer_token_env_var = "PRIVATE_TOKEN"\n';
    writeFileSync(file, original);
    const servers = getMcpServers(['notion', 'linear']).map(({ id, url }) => ({ id, url }));
    const result = runWriter(directory, servers);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { added: ['linear'], existing: ['notion'] });
    const updated = readFileSync(file, 'utf8');
    assert.ok(updated.startsWith(original));
    assert.doesNotMatch(result.stdout, /PRIVATE_TOKEN/);
    assert.equal(runWriter(directory, servers).status, 0);
    assert.equal(readFileSync(file, 'utf8'), updated);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Codex writer refuses invalid and incompatible TOML without changing any bytes', { skip: !hasPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'suped-mcp-'));
  try {
    const file = join(directory, 'config.toml');
    for (const original of ['[broken TOML', 'mcp_servers = { custom = { url = "https://example.com" } }\n']) {
      writeFileSync(file, original);
      const result = runWriter(directory, getMcpServers(['notion']));
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(file, 'utf8'), original);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Codex writer refuses a concurrent registration and keeps the config', { skip: !hasPython }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'suped-mcp-'));
  try {
    const file = join(directory, 'config.toml');
    writeFileSync(file, '# original');
    mkdirSync(join(directory, '.suped-mcp.lock'));
    assert.notEqual(runWriter(directory, getMcpServers(['notion'])).status, 0);
    assert.equal(readFileSync(file, 'utf8'), '# original');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

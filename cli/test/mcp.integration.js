import assert from 'node:assert/strict';

// Only called by the isolated integration runner after selected agent clients
// are installed. These checks register endpoints but never authorize accounts,
// launch an agent session, or invoke an MCP tool.
export function checkMcp({ cli, selectedTools }) {
  assert.match(process.env.SUPED_CONTAINER || '', /^suped-(ci|verify)(-|$)/, 'MCP smoke requires an isolated test container');
  const selected = new Set(selectedTools.map((tool) => typeof tool === 'string' ? tool : tool.id));
  const snapshots = [];
  const read = (file) => cli(['exec', 'cat', file]);
  const sentinel = 'https://example.invalid/suped-integration-sentinel';

  if (selected.has('codex')) {
    const file = '/home/suped/.codex/config.toml';
    const original = '# Suped preservation sentinel\napproval_policy = "on-request"\n\n[mcp_servers.notion]\nurl = "' + sentinel + '"\n';
    cli(['exec', 'node', '-e', `
const fs = require('node:fs');
const directory = '/home/suped/.codex';
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(directory + '/config.toml', fs.readFileSync(0), { flag: 'wx', mode: 0o600 });
`], { input: original });
    const output = cli(['mcp', 'add', 'notion', 'linear', '--client', 'codex']);
    assert.match(output, /notion: existing client configuration kept/);
    assert.match(output, /linear: registered for codex; account access has not been verified/);
    assert.ok(read(file).startsWith(original), 'Codex must preserve original settings and comments');

    for (const [name, expectedUrl] of [['notion', sentinel], ['linear', 'https://mcp.linear.app/mcp']]) {
      const config = JSON.parse(cli(['exec', 'codex', 'mcp', 'get', name, '--json']));
      assert.equal(config.url ?? config.transport?.url, expectedUrl, `native Codex must recognize ${name}`);
    }
    const before = read(file);
    cli(['mcp', 'add', 'linear', 'notion', '--client=codex']);
    assert.equal(read(file), before, 'repeat Codex MCP setup must preserve every config byte');
    snapshots.push({ file, content: before, client: 'Codex' });
    console.log('PASS Codex MCP registration, native config lookup, existing entries, and repeat setup');
  }

  if (selected.has('claude')) {
    const file = '/home/suped/.claude.json';
    cli(['exec', 'node', '-e', `
const fs = require('node:fs');
const file = '/home/suped/.claude.json';
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (config.mcpServers?.notion) throw new Error('unexpected pre-existing integration test entry');
config.supedPreservationSentinel = 'keep-me';
config.mcpServers = { ...config.mcpServers, notion: { type: 'http', url: ${JSON.stringify(sentinel)} } };
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 });
`]);
    const output = cli(['mcp', 'add', 'notion', 'linear', '--client', 'claude']);
    assert.match(output, /notion: existing client configuration kept/);
    assert.match(output, /linear: registered for claude; account access has not been verified/);
    const configured = JSON.parse(read(file));
    assert.equal(configured.supedPreservationSentinel, 'keep-me');
    assert.equal(configured.mcpServers.notion.url, sentinel);
    assert.equal(configured.mcpServers.linear.url, 'https://mcp.linear.app/mcp');
    assert.equal(configured.mcpServers.linear.type, 'http');

    assert.ok(cli(['exec', 'claude', 'mcp', 'get', 'notion']).includes(sentinel), 'native Claude must recognize the preserved entry');
    assert.ok(cli(['exec', 'claude', 'mcp', 'get', 'linear']).includes('https://mcp.linear.app/mcp'), 'native Claude must recognize the registered entry');
    const before = JSON.parse(read(file));
    cli(['mcp', 'add', 'linear', 'notion', '--client=claude']);
    assert.deepEqual(JSON.parse(read(file)), before, 'repeat Claude MCP setup must preserve config data');
    snapshots.push({ file, content: before, client: 'Claude Code' });
    console.log('PASS Claude MCP registration, native config lookup, existing entries, and repeat setup');
  }

  return function verifyMcpPersistence() {
    for (const { file, content, client } of snapshots) {
      if (client === 'Codex') assert.equal(read(file), content);
      else assert.deepEqual(JSON.parse(read(file)), content);
      console.log(`PASS ${client} MCP configuration survives reset`);
    }
  };
}

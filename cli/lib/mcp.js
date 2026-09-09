import * as computer from './computer.js';
import { MCP_SERVERS, getMcpServers } from './catalog/mcp.js';

const HELP = `usage
  suped mcp list
  suped mcp add <servers...> --client claude|codex
  suped mcp export <servers...> --client claude|codex|cursor

add registers servers in the selected client inside your persistent home.
Then authorize each connection in that client. Registration does not verify login.
export prints a config fragment without changing files; merge it into client config.
Example: suped mcp add notion linear --client claude
`;

// Return names only, never credentials or existing server configuration.
export const READ_CLAUDE_SERVERS = `
const fs = require('node:fs');
const path = require('node:path');
const home = require('node:os').homedir();
const directory = process.env.CLAUDE_CONFIG_DIR || home;
const file = path.join(directory, '.claude.json');
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
const config = read(file);
const names = new Set(Object.keys(config.mcpServers || {}));
for (const project of Object.values(config.projects || {})) {
  for (const name of Object.keys(project.mcpServers || {})) names.add(name);
}
for (const name of Object.keys(read(path.join(process.cwd(), '.mcp.json')).mcpServers || {})) names.add(name);
process.stdout.write(JSON.stringify([...names]));
`;

// Codex's native `mcp add` can immediately start OAuth and has no skip-login
// switch. Register without networking, using Python's standard TOML parser to
// validate the complete result before replacing the on-box config atomically.
// Existing bytes (including comments and unrelated settings) stay intact.
export const REGISTER_CODEX_SERVERS = `
import json, os, pathlib, stat, sys, tempfile, tomllib
servers = json.load(sys.stdin)
home = pathlib.Path(os.environ.get('CODEX_HOME') or pathlib.Path.home() / '.codex')
home.mkdir(parents=True, exist_ok=True, mode=0o700)
lock = home / '.suped-mcp.lock'
try:
    lock.mkdir(mode=0o700)
except FileExistsError:
    raise SystemExit('another Suped MCP setup is running; retry after it finishes')
temporary = None
try:
    target = home / 'config.toml'
    if target.is_symlink():
        raise SystemExit('config.toml is a symlink; configure this client manually')
    original = target.read_bytes() if target.exists() else b''
    parsed = tomllib.loads(original.decode('utf-8'))
    configured = parsed.get('mcp_servers', {})
    if not isinstance(configured, dict):
        raise SystemExit('mcp_servers must be a TOML table')
    existing = [server['id'] for server in servers if server['id'] in configured]
    added = [server for server in servers if server['id'] not in configured]
    if added:
        blocks = ''.join('\\n[mcp_servers.' + json.dumps(server['id']) + ']\\nurl = ' + json.dumps(server['url']) + '\\n' for server in added)
        updated = original + blocks.encode('utf-8')
        tomllib.loads(updated.decode('utf-8'))
        mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o600
        descriptor, temporary = tempfile.mkstemp(prefix='.suped-mcp-', dir=home)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(updated)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        current = target.read_bytes() if target.exists() else b''
        if current != original:
            raise SystemExit('config.toml changed during setup; retry')
        os.replace(temporary, target)
        temporary = None
    print(json.dumps({'added': [server['id'] for server in added], 'existing': existing}))
finally:
    if temporary is not None:
        os.unlink(temporary)
    lock.rmdir()
`;

export function parseMcpArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { action: 'help', servers: [] };
  const [action = 'list', ...rest] = args;
  const ids = [];
  let client;
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--client' || value.startsWith('--client=')) {
      if (client) throw new Error('mcp: specify --client only once');
      client = value === '--client' ? rest[++i] : value.slice('--client='.length);
      if (!client || client.startsWith('-')) throw new Error('mcp: --client requires claude, codex, or cursor');
    } else if (value.startsWith('-')) throw new Error(`mcp: unknown option "${value}"`);
    else ids.push(value);
  }
  if (action === 'help' || action === '--help' || action === '-h') return { action: 'help', servers: [] };
  if (!['list', 'add', 'export'].includes(action)) throw new Error(`unknown MCP command "${action}". Try "suped mcp help".`);
  if (action === 'list') {
    if (ids.length || client) throw new Error('usage: suped mcp list');
    return { action, servers: [] };
  }
  if (!client || !['claude', 'codex', 'cursor'].includes(client)) throw new Error('mcp: select --client claude|codex|cursor');
  if (action === 'add' && client === 'cursor') throw new Error('Cursor uses config export: suped mcp export <servers...> --client cursor');
  if (!ids.length) throw new Error(`mcp ${action}: choose servers. Run "suped mcp list".`);
  return { action, client, servers: getMcpServers(ids) };
}

export function exportMcpConfig(servers, client) {
  if (client === 'codex') return servers.map(({ id, url }) => `[mcp_servers.${JSON.stringify(id)}]\nurl = ${JSON.stringify(url)}`).join('\n\n') + '\n';
  if (!['claude', 'cursor'].includes(client)) throw new Error('unsupported MCP client');
  return JSON.stringify({ mcpServers: Object.fromEntries(servers.map(({ id, url }) => [id, client === 'claude' ? { type: 'http', url } : { url }])) }, null, 2) + '\n';
}

export function createMcp({
  capture = computer.capture,
  ensureUp = computer.ensureUp,
  log = (message) => console.log(message),
  write = (message) => process.stdout.write(message),
} = {}) {
  async function mainMcp(args, { runArgs = [] } = {}) {
    // Validate the entire request before starting Docker or changing any file.
    const { action, client, servers } = parseMcpArgs(args);
    if (action === 'help') { write(HELP); return 0; }
    if (action === 'list') {
      log('Official remote MCP servers\n');
      for (const server of MCP_SERVERS) log(`${server.id.padEnd(12)} ${server.category.padEnd(14)} ${server.description}`);
      log('\nRegister: suped mcp add notion linear --client claude');
      log('Authorize connections in your agent client after registration.');
      return 0;
    }
    if (action === 'export') { write(exportMcpConfig(servers, client)); return 0; }

    ensureUp({ runArgs, log });
    if (capture([client, '--version']).status !== 0) throw new Error(`${client} is not installed in the workspace. Run "suped setup ${client} --skip-auth" first.`);
    let added = [];
    let existing = [];
    let failed = false;
    if (client === 'codex') {
      const result = capture(['python3', '-c', REGISTER_CODEX_SERVERS], { input: JSON.stringify(servers.map(({ id, url }) => ({ id, url }))) });
      if (result.status !== 0) throw new Error('could not register Codex MCP servers. Check ~/.codex/config.toml for invalid TOML or inline mcp_servers tables, symlinks, and write permissions; an interrupted setup may leave ~/.codex/.suped-mcp.lock. Existing config was kept.');
      try { ({ added, existing } = JSON.parse(result.stdout)); }
      catch { throw new Error('could not read the Codex registration result; inspect "suped exec codex mcp list" before retrying'); }
    } else {
      const result = capture(['node', '-e', READ_CLAUDE_SERVERS]);
      let configured;
      try {
        if (result.status !== 0) throw new Error();
        configured = JSON.parse(result.stdout);
        if (!Array.isArray(configured) || configured.some((id) => typeof id !== 'string')) throw new Error();
      } catch { throw new Error('could not read Claude MCP configuration. Check ~/.claude.json and .mcp.json; existing files were kept.'); }
      for (const server of servers) {
        if (configured.includes(server.id)) { existing.push(server.id); continue; }
        const result = capture(['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', server.id, server.url]);
        if (result.status !== 0) {
          log(`${server.name}: registration failed. Inspect "suped exec claude mcp get ${server.id}" and retry.`);
          failed = true;
        } else added.push(server.id);
      }
    }
    for (const id of existing) log(`${id}: existing client configuration kept; inspect it in the client before use.`);
    for (const id of added) log(`${id}: registered for ${client}; account access has not been verified.`);
    for (const server of servers) if (server.note) log(`${server.name}: ${server.note}`);
    if (client === 'claude') {
      log('\nAuthorize each server from an interactive terminal:');
      for (const id of added) log(`  suped exec claude mcp login ${id} --no-browser`);
      log('Open the printed URL in your browser and paste the full callback URL back into the client when prompted.');
      log('You can also run "suped exec claude", then /mcp to authorize and check servers.');
    }
    else {
      log('\nAuthorize each server using its native client login:');
      for (const id of added) log(`  suped exec codex mcp login ${id}`);
      log('Check "suped exec codex mcp list" and /mcp in Codex before handing it work.');
    }
    log('Browser OAuth callbacks must reach the client inside the container. See https://suped.dev/docs/mcp for container login instructions.');
    return failed ? 1 : 0;
  }
  return { mainMcp };
}

export const { mainMcp } = createMcp();

/** Optional final step for guided setup; nothing is selected by default. */
export async function chooseMcp({ ask, clients, log = (message) => console.log(message), register = mainMcp }) {
  const available = [...new Set(clients)].filter((client) => ['claude', 'codex'].includes(client));
  if (!available.length) return 0;
  log('\nAdd service connections through MCP (optional).');
  for (const [index, server] of MCP_SERVERS.entries()) log(`  ${index + 1}  ${server.name} — ${server.description}`);
  let selected;
  for (;;) {
    const answer = (await ask('Connections (names or numbers, separated by commas; Enter to skip): ')).trim();
    if (!answer || ['none', 'skip'].includes(answer.toLowerCase())) return 0;
    const ids = answer.split(/[\s,]+/).map((id) => /^\d+$/.test(id) ? MCP_SERVERS[Number(id) - 1]?.id ?? id : id);
    try { selected = getMcpServers(ids); break; }
    catch (error) { log(error.message); }
  }
  let client = available[0];
  if (available.length > 1) {
    for (const [index, name] of available.entries()) log(`  ${index + 1}  ${name}`);
    for (;;) {
      const answer = (await ask(`Agent client [${client}]: `)).trim().toLowerCase() || client;
      const candidate = /^\d+$/.test(answer) ? available[Number(answer) - 1] : answer;
      if (available.includes(candidate)) { client = candidate; break; }
      log(`Choose ${available.join(' or ')}.`);
    }
  }
  return register(['add', ...selected.map((server) => server.id), '--client', client]);
}

import { createInterface } from 'node:readline/promises';
import * as computer from './computer.js';
import { TOOLS, CATEGORIES, getTools } from './tools.js';

// This file configures the user's workspace. Agents use the installed CLIs
// directly; their credentials stay in each provider's normal home directory.
const READ_CONFIG = `
const fs = require('node:fs');
const path = require('node:path').join(require('node:os').homedir(), '.config/suped/setup.json');
try { process.stdout.write(fs.readFileSync(path, 'utf8')); }
catch (error) { if (error.code === 'ENOENT') process.stdout.write('null'); else throw error; }
`;
const WRITE_CONFIG = `
const fs = require('node:fs');
const path = require('node:path').join(require('node:os').homedir(), '.config/suped/setup.json');
const input = fs.readFileSync(0, 'utf8');
JSON.parse(input);
fs.mkdirSync(require('node:path').dirname(path), { recursive: true, mode: 0o700 });
const temporary = path + '.' + process.pid + '.tmp';
fs.writeFileSync(temporary, input + '\\n', { mode: 0o600 });
fs.renameSync(temporary, path);
`;

async function askTerminal(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  rl.once('SIGINT', cancel);
  rl.once('close', cancel);
  try {
    return await rl.question(question, { signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('setup cancelled; run "suped setup" to continue');
    throw error;
  } finally {
    rl.removeListener('close', cancel);
    rl.close();
  }
}

export function createSetup({
  run = computer.exec,
  capture = computer.capture,
  isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask = askTerminal,
  log = (message) => console.log(message),
  configureMcp = async (options) => (await import('./mcp.js')).chooseMcp(options),
} = {}) {
  function readConfig() {
    const result = capture(['node', '-e', READ_CONFIG]);
    if (result.status !== 0) throw new Error('could not read workspace setup; check that the computer is running');
    let config;
    try { config = JSON.parse(result.stdout); }
    catch { throw new Error('invalid ~/.config/suped/setup.json; repair or move that file and run "suped setup" again'); }
    if (config !== null && (config.version !== 1 || !Array.isArray(config.tools) ||
        !config.tools.every((id) => typeof id === 'string') || typeof config.completed !== 'boolean')) {
      throw new Error('unsupported workspace setup file; update Suped or inspect ~/.config/suped/setup.json');
    }
    return config;
  }

  function saveConfig(config) {
    const result = capture(['node', '-e', WRITE_CONFIG], { input: JSON.stringify(config) });
    if (result.status !== 0) throw new Error('could not save workspace setup; your installed tools are still available');
  }

  function installed(tool) {
    return capture([tool.command, ...(tool.versionArgs || ['--version'])]).status === 0;
  }

  function connected(tool) {
    const result = capture(tool.check);
    return tool.connected ? tool.connected(result) : result.status === 0;
  }

  async function chooseTools() {
    log('\nA suped-up workspace for your agent.');
    log('Choose the tools you use. Install them here, then connect your accounts.\n');
    log('  1  Websites and web apps — choose your repository, hosting, and services');
    log('  2  Data, scripts, and services — choose your databases and cloud tools');
    log('  3  Pick from the full catalogue');
    log('  4  Base workspace only\n');
    for (;;) {
      const choice = (await ask('How do you work? [1]: ')).trim() || '1';
      if (choice === '4') return [];
      if (choice === '1' || choice === '2') {
        const selected = [];
        for (const category of CATEGORIES) {
          if (choice === '2' && category.id === 'hosting') continue;
          const options = TOOLS.filter((tool) => tool.category === category.id);
          if (!options.length) continue;
          const defaults = choice === '1' ? { source: 'github', hosting: 'cloudflare' } : {};
          const fallback = defaults[category.id] || 'none';
          log(`\n${category.name}`);
          for (const [index, tool] of options.entries()) log(`  ${index + 1}  ${tool.name} (${tool.id}) — ${tool.description}`);
          for (;;) {
            const answer = (await ask(`Choose numbers or names, comma-separated; "none" to skip [${fallback}]: `)).trim() || fallback;
            if (answer.toLowerCase() === 'none') break;
            try {
              const tools = getTools(answer.split(/[\s,]+/).filter(Boolean).map((id) => /^\d+$/.test(id) ? options[Number(id) - 1]?.id ?? id : id));
              if (tools.some((tool) => tool.category !== category.id)) throw new Error(`Choose from ${category.name.toLowerCase()} above, or enter "none".`);
              selected.push(...tools);
              break;
            } catch (error) { log(error.message); }
          }
        }
        return [...new Set(selected)];
      }
      if (choice !== '3') { log('Enter 1, 2, 3, or 4.'); continue; }
      for (const category of CATEGORIES) {
        log(`\n${category.name}`);
        for (const tool of TOOLS.filter((entry) => entry.category === category.id)) log(`  ${TOOLS.indexOf(tool) + 1}  ${tool.name} (${tool.id}) — ${tool.description}`);
      }
      for (;;) {
        const answer = (await ask('Tools (numbers or names, separated by commas; "none" for base only): ')).trim();
        if (answer.toLowerCase() === 'none') return [];
        const ids = answer.split(/[\s,]+/).filter(Boolean).map((id) => /^\d+$/.test(id) ? TOOLS[Number(id) - 1]?.id ?? id : id);
        if (!ids.length) { log('Choose at least one tool, or enter "none".'); continue; }
        try { return getTools(ids); }
        catch (error) { log(error.message); }
      }
    }
  }

  async function authenticate(tool) {
    if (connected(tool)) {
      if (tool.afterLogin && run(tool.afterLogin) !== 0) {
        log(`${tool.name}: connected, but additional setup failed. Retry with "suped login ${tool.id}".`);
        return 1;
      }
      log(`${tool.name}: already connected.`);
      return 0;
    }
    log(`\nConnect ${tool.name}. ${tool.authInstructions || 'Follow the provider login instructions below.'}`);
    if (!tool.login) {
      for (const instruction of [].concat(tool.manualConnect || [])) log(instruction);
      log(`${tool.name}: installed; finish the provider connection, then run "suped tools ${tool.id}" to verify it.`);
      return 1;
    }
    if (run(tool.login) !== 0) {
      log(`${tool.name}: login did not finish. Retry with "suped login ${tool.id}".`);
      return 1;
    }
    if (!connected(tool)) {
      log(`${tool.name}: could not verify access. Retry with "suped login ${tool.id}".`);
      return 1;
    }
    if (tool.afterLogin && run(tool.afterLogin) !== 0) {
      log(`${tool.name}: signed in, but additional setup failed. Retry with "suped login ${tool.id}".`);
      return 1;
    }
    log(`${tool.name}: connected.`);
    return 0;
  }

  async function setup({ tools = null, authenticate: shouldAuthenticate = true, interactive = isInteractive() } = {}) {
    // Validate all input before installing anything or asking for credentials.
    let selected = tools === null ? null : getTools(tools);
    if (!interactive && selected === null) throw new Error('setup needs a terminal; use "suped setup github cloudflare --skip-auth" for unattended installation');
    if (!interactive && shouldAuthenticate && selected.length) throw new Error('login needs a terminal; add --skip-auth, then run "suped login <tool>" interactively');
    const previous = readConfig();
    if (selected === null) selected = await chooseTools();
    let failed = false;
    const installedIds = new Set(previous?.tools || []);
    const successful = [];
    for (const tool of selected) {
      log(`\nInstalling ${tool.name} in your persistent home...`);
      if (run(['bash', '-c', tool.install]) !== 0 || !installed(tool)) {
        log(`${tool.name}: installation failed. Run "suped setup ${tool.id}" to retry.`);
        failed = true;
        continue;
      }
      installedIds.add(tool.id);
      successful.push(tool);
      log(`${tool.name}: installed (${tool.command}).`);
    }
    saveConfig({ version: 1, tools: [...installedIds], completed: !failed });
    for (const tool of successful) {
      if (!shouldAuthenticate) continue;
      const answer = (await ask(`Connect your ${tool.name} account now? [Y/n]: `)).trim().toLowerCase();
      if (answer && answer !== 'y' && answer !== 'yes') continue;
      if (await authenticate(tool) !== 0) failed = true;
    }
    if (tools === null && interactive && shouldAuthenticate) {
      const clients = successful.filter((tool) => tool.category === 'agents').map((tool) => tool.id);
      if (clients.length && await configureMcp({ ask, clients, log }) !== 0) failed = true;
    }
    log('\nYour files, selected tools, and saved logins live in /home/suped.');
    log('Run "suped tools" to check connections, or "suped setup" to add tools.');
    log('Hand your agent this workspace. It can use the normal CLIs directly.');
    return failed ? 1 : 0;
  }

  async function setupIfNeeded() {
    if (!isInteractive()) return 0;
    if (readConfig()?.completed) return 0;
    return setup();
  }

  async function showTools(ids = []) {
    const selected = ids.length ? getTools(ids) : TOOLS;
    log('Workspace tools\n');
    for (const tool of selected) {
      const state = !installed(tool) ? 'not installed' : connected(tool) ? 'connected' : 'installed; connection not verified';
      log(`${tool.name.padEnd(15)} ${tool.command.padEnd(12)} ${state}`);
    }
    log('\nAdd tools: suped setup     Connect an account: suped login <tool>');
    log('Connection checks use the provider CLI. Expired credentials or network failures need attention.');
    return 0;
  }

  async function loginTools(ids) {
    const selected = getTools(ids);
    if (!selected.length) throw new Error('choose a tool: suped login <tool>; run "suped catalog" for choices');
    if (!isInteractive()) throw new Error('login needs an interactive terminal; run "suped login <tool>" from a terminal');
    for (const tool of selected) {
      if (!installed(tool)) throw new Error(`${tool.name} is not installed; run "suped setup ${tool.id}" first`);
    }
    let status = 0;
    for (const tool of selected) if (await authenticate(tool) !== 0) status = 1;
    return status;
  }

  return { setup, setupIfNeeded, showTools, loginTools };
}

export const { setup, setupIfNeeded, showTools, loginTools } = createSetup();

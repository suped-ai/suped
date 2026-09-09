// Explicit, isolated Docker integration check. Never uses the default computer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, getTools } from '../lib/tools.js';
import { checkMcp } from './mcp.integration.js';

const container = process.env.SUPED_CONTAINER;
const volume = process.env.SUPED_VOLUME;
assert.match(container || '', /^suped-(ci|verify)(-|$)/, 'set a dedicated SUPED_CONTAINER starting with suped-ci or suped-verify');
assert.match(volume || '', /^suped-(ci|verify)(-|$)/, 'set a dedicated SUPED_VOLUME starting with suped-ci or suped-verify');
assert.ok(process.env.SUPED_IMAGE, 'set SUPED_IMAGE to a built test image');
const bin = fileURLToPath(new URL('../bin/suped.js', import.meta.url));
const selectedTools = process.env.SUPED_TEST_TOOLS !== '1' ? []
  : process.env.SUPED_TEST_TOOL_IDS ? getTools(process.env.SUPED_TEST_TOOL_IDS) : TOOLS;

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}
assert.equal(docker(['version']).status, 0, 'Docker must be running');
assert.equal(docker(['image', 'inspect', process.env.SUPED_IMAGE]).status, 0, 'build the test image first');
assert.notEqual(docker(['container', 'inspect', container]).status, 0, 'test container already exists; choose another name');
assert.notEqual(docker(['volume', 'inspect', volume]).status, 0, 'test home already exists; choose another name');

function cli(args, { input, expected = 0, timeout = 15 * 60 * 1000 } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', env: process.env, input, windowsHide: true,
    maxBuffer: 16 * 1024 * 1024, timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${args[0]} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

const probeDir = mkdtempSync(join(tmpdir(), 'suped-check-'));
writeFileSync(join(probeDir, 'input.txt'), 'host mount survived\n');
try {
  cli(['-p', '127.0.0.1::3000', '-v', `${probeDir}:/home/suped/test-mount:ro`, 'up']);
  assert.match(cli(['exec', 'node', '--version']), /^v\d+/);
  const args = ['two words', '', 'semi;colon', '$(echo should-not-run)', 'quote"value'];
  const echoed = cli(['exec', 'node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.deepEqual(JSON.parse(echoed), args);
  assert.equal(cli(['exec', 'cat'], { input: 'piped input\n' }), 'piped input\n');
  cli(['exec', 'sh', '-c', 'exit 7'], { expected: 7 });
  cli(['exec', 'mkdir -p ~/.config/suped && printf "saved\\n" > ~/.config/suped/probe.txt']);
  assert.equal(cli(['exec', 'cat', '/home/suped/test-mount/input.txt']), 'host mount survived\n');
  console.log('PASS exact arguments, stdin, exit status, and host mounts');

  if (selectedTools.length) {
    for (const tool of selectedTools) {
      console.log(`Installing ${tool.name} ${tool.version}...`);
      cli(['setup', tool.id, '--skip-auth']);
      assert.ok(cli(['exec', tool.command, ...(tool.versionArgs || ['--version'])]).trim());
      const fingerprint = cli(['exec', 'stat', '-c', '%i %Y %N', `/home/suped/.local/bin/${tool.command}`]);
      cli(['setup', tool.id, '--skip-auth']);
      assert.equal(cli(['exec', 'stat', '-c', '%i %Y %N', `/home/suped/.local/bin/${tool.command}`]), fingerprint, `${tool.id} repeat setup should keep its current pinned installation`);
      // Native login help validates the configured flags without starting auth.
      // Neon's Bash prompt is covered by unit tests; its native stdin command
      // and Turso's manual headless command are checked separately below.
      if (tool.login && tool.login[0] !== 'bash') cli(['exec', ...tool.login, '--help'], { timeout: 30_000 });
      if (tool.id === 'neon') cli(['exec', 'neon', 'profile', 'create', '--help'], { timeout: 30_000 });
      if (tool.id === 'turso') cli(['exec', 'turso', 'auth', 'login', '--help'], { timeout: 30_000 });
      const state = cli(['tools', tool.id], { timeout: 30_000 });
      assert.match(state, /installed; connection not verified/, `${tool.id} must not claim an account connection in a fresh workspace`);
      console.log(`PASS ${tool.name} installation, repeat setup, login flags, and signed-out status`);
    }
    // Provider login flag availability is checked without starting authentication.
    if (selectedTools.some((tool) => tool.id === 'cloudflare')) assert.match(cli(['exec', 'wrangler', 'login', '--help']), /--device/);
    if (selectedTools.some((tool) => tool.id === 'supabase')) assert.match(cli(['exec', 'supabase', 'login', '--help']), /--no-browser/);
  }

  const verifyMcp = checkMcp({ cli, selectedTools });
  const before = JSON.parse(docker(['container', 'inspect', container]).stdout)[0];
  cli(['reset']);
  const after = JSON.parse(docker(['container', 'inspect', container]).stdout)[0];
  assert.deepEqual(after.HostConfig.Binds, before.HostConfig.Binds);
  assert.deepEqual(after.HostConfig.PortBindings, before.HostConfig.PortBindings);
  assert.equal(cli(['exec', 'cat', '/home/suped/.config/suped/probe.txt']), 'saved\n');
  assert.equal(cli(['exec', 'cat', '/home/suped/test-mount/input.txt']), 'host mount survived\n');
  verifyMcp();
  if (selectedTools.length) {
    for (const tool of selectedTools) assert.ok(cli(['exec', tool.command, ...(tool.versionArgs || ['--version'])]).trim());
    const config = JSON.parse(cli(['exec', 'cat', '/home/suped/.config/suped/setup.json']));
    assert.deepEqual(config.tools, selectedTools.map((tool) => tool.id));
    assert.equal(config.completed, true);
  }
  cli(['stop']);
  cli(['up']);
  assert.equal(cli(['exec', 'cat', '/home/suped/.config/suped/probe.txt']), 'saved\n');
  cli(['exec', 'NODE_PATH="$(npm root -g)" node -e \'require("playwright").chromium.launch().then(b=>b.close()).then(()=>console.log("chromium ok"))\'']);
  console.log('PASS reset/restart persistence, retained connections, and Chromium launch');
} finally {
  // Names were checked absent above and are explicit test-only names.
  cli(['destroy', '--yes']);
  const target = resolve(probeDir);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('suped-check-'));
  rmSync(target, { recursive: true, force: true });
}
console.log('PASS isolated test container and home removed');

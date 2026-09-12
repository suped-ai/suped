import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, CATEGORIES, getTools, showCatalog } from '../lib/tools.js';

test('catalogue has unique ids and resolvable CLI aliases, with complete setup metadata', () => {
  assert.equal(new Set(TOOLS.map((tool) => tool.id)).size, TOOLS.length);
  for (const tool of TOOLS) {
    assert.ok(CATEGORIES.some((category) => category.id === tool.category), tool.id);
    assert.match(tool.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof tool.install, 'string');
    if (tool.account === false) {
      // Install-only. Carrying login machinery it can never use is how a
      // workspace manager ends up being offered an account to connect.
      assert.equal(tool.login, undefined, `${tool.id} has no account, so it must not have a login`);
      assert.equal(tool.connected, undefined, `${tool.id} has no account, so it must not have a connection check`);
      assert.equal(tool.check, undefined, `${tool.id} has no account, so it must not have a check`);
    } else {
      assert.equal(typeof tool.connected, 'function');
      assert.ok(Array.isArray(tool.check) && tool.check.length > 0);
    }
    assert.deepEqual(getTools([tool.command]), [tool]);
  }
  assert.deepEqual(getTools(['glab,neon', 'vercel', 'pscale']).map((tool) => tool.id), ['gitlab', 'neon', 'vercel', 'planetscale']);
});

test('catalogue browsing groups every tool exactly once without accessing Docker', () => {
  const lines = [];
  assert.equal(showCatalog((line) => lines.push(line)), 0);
  for (const tool of TOOLS) assert.equal(lines.filter((line) => line.startsWith(`  ${tool.id.padEnd(12)} `)).length, 1);
});

test('agent connection checks distinguish logged out responses from login status', () => {
  const [codex, claude] = getTools(['codex', 'claude']);
  assert.equal(codex.connected({ status: 0, stdout: '', stderr: 'Logged in using ChatGPT' }), true);
  assert.equal(claude.connected({ status: 0, stdout: '{"loggedIn":true}' }), true);
  for (const tool of [codex, claude]) {
    for (const response of [undefined, { status: 0, stdout: '' }, { status: 1, stdout: '{"loggedIn":true}', stderr: 'Logged in using ChatGPT' }, { status: 0, stdout: '{"loggedIn":false}', stderr: 'Not logged in' }]) {
      assert.equal(tool.connected(response), false, tool.id);
    }
  }
});

test('no tool installs a daemon or reaches for the host Docker socket', () => {
  // Mounting the host socket into the workspace gives anything in it root on
  // the host. Suped installs the Docker client and nothing else; a daemon is
  // something the operator points it at deliberately.
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.install, /docker\.sock/, `${tool.id} must not reference the host Docker socket`);
    assert.doesNotMatch(tool.install, /\bdockerd\b/, `${tool.id} must not install a Docker daemon`);
  }
  const docker = getTools(['docker'])[0];
  assert.equal(docker.account, false);
  // The CLI goes on PATH; its subcommands are plugins, which do not.
  assert.match(docker.install, /\$HOME\/\.docker\/cli-plugins/);
  for (const plugin of ['docker-buildx', 'docker-compose']) assert.ok(docker.install.includes(plugin), plugin);
});

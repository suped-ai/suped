import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetup } from '../lib/setup.js';
import { TOOLS } from '../lib/tools.js';

function fixture({ interactive = true, config = null, answers = [], failInstall, failLogin, initialInstalled = [], initialConnected = [] } = {}) {
  const calls = [];
  const logs = [];
  const installed = new Set(initialInstalled);
  const connected = new Set(initialConnected);
  let saved = config;
  const instance = createSetup({
    isInteractive: () => interactive,
    ask: async (question) => { calls.push(['ask', question]); assert.ok(answers.length, 'unexpected prompt'); return answers.shift(); },
    log: (message) => logs.push(message),
    capture: (command, options = {}) => {
      calls.push(['capture', command, options]);
      if (command[0] === 'node') {
        if (options.input !== undefined) { saved = JSON.parse(options.input); return { status: 0, stdout: '', stderr: '' }; }
        return { status: 0, stdout: JSON.stringify(saved), stderr: '' };
      }
      const version = TOOLS.find((tool) => JSON.stringify(command) === JSON.stringify([tool.command, ...(tool.versionArgs || ['--version'])]));
      if (version) return { status: installed.has(version.id) ? 0 : 127, stdout: 'version', stderr: '' };
      const tool = TOOLS.find((tool) => JSON.stringify(tool.check) === JSON.stringify(command));
      assert.ok(tool, `unexpected command ${command}`);
      const stdout = tool.id === 'github' ? '{"login":"test-user","id":123}' : tool.id === 'cloudflare' ? '{"loggedIn":true}' : '[]';
      return { status: connected.has(tool.id) ? 0 : 1, stdout, stderr: '' };
    },
    run: (command) => {
      calls.push(['run', command]);
      const installing = TOOLS.find((tool) => command[2] === tool.install);
      if (installing) {
        if (installing.id === failInstall) return 1;
        installed.add(installing.id);
        return 0;
      }
      const login = TOOLS.find((tool) => JSON.stringify(tool.login) === JSON.stringify(command));
      if (login) {
        if (login.id === failLogin) return 1;
        connected.add(login.id);
        return 0;
      }
      assert.ok(TOOLS.some((tool) => JSON.stringify(tool.afterLogin) === JSON.stringify(command)), `unexpected run ${command}`);
      return 0;
    },
  });
  return { ...instance, calls, logs, saved: () => saved };
}

test('unattended setup requires explicit tools and never starts native login', async () => {
  const f = fixture({ interactive: false });
  await assert.rejects(f.setup(), /needs a terminal/);
  await assert.rejects(f.setup({ tools: ['github'] }), /skip-auth/);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.setup({ tools: ['github', 'cloudflare'], authenticate: false }), 0);
  assert.deepEqual(f.saved(), { version: 1, tools: ['github', 'cloudflare'], completed: true });
  assert.equal(f.calls.some(([kind]) => kind === 'ask'), false);
  assert.equal(f.calls.filter(([kind, command]) => kind === 'run' && command[0] !== 'bash').length, 0);
});

test('unknown tools fail before changing the workspace', async () => {
  const f = fixture();
  await assert.rejects(f.setup({ tools: ['github', 'unknown'] }), /unknown/i);
  assert.equal(f.calls.length, 0);
});

test('guided setup can use defaults, skip extra categories, and defer account login', async () => {
  const f = fixture({ answers: ['', '', '', '', '', '', '', 'n', 'n'] });
  assert.equal(await f.setupIfNeeded(), 0);
  assert.deepEqual(f.saved().tools, ['github', 'cloudflare']);
  assert.equal(f.saved().completed, true);
  assert.equal(await f.setupIfNeeded(), 0, 'subsequent launches do not prompt');
});

test('guided setup accepts provider alternatives and validates category choices', async () => {
  const f = fixture({ answers: ['1', 'neon', 'glab', 'vercel', 'neon', 'none', 'stripe', 'none'] });
  assert.equal(await f.setup({ authenticate: false }), 0);
  assert.deepEqual(f.saved().tools, ['gitlab', 'vercel', 'neon', 'stripe']);
  assert.ok(f.logs.some((message) => /Choose from repositories/.test(message)));
});

test('tool status can check one provider without probing other accounts', async () => {
  const f = fixture({ initialInstalled: ['github'], initialConnected: ['github'] });
  assert.equal(await f.showTools(['gh']), 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'capture').length, 2);
  assert.equal(f.logs.some((message) => /Supabase/.test(message)), false);
});

test('manual connection prints concrete instructions without executing a login', async () => {
  const f = fixture({ initialInstalled: ['turso'] });
  assert.equal(await f.loginTools(['turso']), 1);
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false);
  assert.ok(f.logs.some((message) => /turso auth login --headless/.test(message)));
});

test('base-only choice completes setup without tool installation', async () => {
  const f = fixture({ answers: ['4'] });
  assert.equal(await f.setup(), 0);
  assert.deepEqual(f.saved(), { version: 1, tools: [], completed: true });
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false);
});

test('partial install records successes and remains retryable', async () => {
  const f = fixture({ failInstall: 'cloudflare' });
  assert.equal(await f.setup({ tools: ['github', 'cloudflare'], authenticate: false }), 1);
  assert.deepEqual(f.saved(), { version: 1, tools: ['github'], completed: false });
});

test('adding a tool keeps previous selections', async () => {
  const f = fixture({ config: { version: 1, tools: ['github'], completed: true } });
  assert.equal(await f.setup({ tools: ['supabase'], authenticate: false }), 0);
  assert.deepEqual(f.saved().tools, ['github', 'supabase']);
});

test('successful native login is verified and git credentials configured', async () => {
  const f = fixture({ initialInstalled: ['github'] });
  assert.equal(await f.loginTools(['github']), 0);
  const gh = TOOLS.find((tool) => tool.id === 'github');
  assert.ok(f.calls.some(([kind, command]) => kind === 'run' && JSON.stringify(command) === JSON.stringify(gh.afterLogin)));
  assert.equal(f.saved(), null, 'Suped does not save account credentials');
});

test('already authenticated GitHub still configures git credential helper', async () => {
  const f = fixture({ initialInstalled: ['github'], initialConnected: ['github'] });
  assert.equal(await f.loginTools(['github']), 0);
  const gh = TOOLS.find((tool) => tool.id === 'github');
  assert.ok(f.calls.some(([kind, command]) => kind === 'run' && JSON.stringify(command) === JSON.stringify(gh.afterLogin)));
  assert.equal(f.calls.some(([kind, command]) => kind === 'run' && JSON.stringify(command) === JSON.stringify(gh.login)), false);
});

test('login failure returns a failure and can be retried', async () => {
  const f = fixture({ initialInstalled: ['github'], failLogin: 'github' });
  assert.equal(await f.loginTools(['github']), 1);
  assert.ok(f.logs.some((message) => message.includes('suped login github')));
});

test('noninteractive launches skip setup and login rejects before accessing tools', async () => {
  const f = fixture({ interactive: false });
  assert.equal(await f.setupIfNeeded(), 0);
  await assert.rejects(f.loginTools(['github']), /interactive terminal/);
  assert.equal(f.calls.length, 0);
});

test('missing CLI prompts installation without attempting login', async () => {
  const f = fixture();
  await assert.rejects(f.loginTools(['github']), /suped setup github/);
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false);
});

test('tool status distinguishes absent, installed, and connected without showing captured output', async () => {
  const f = fixture({ initialInstalled: ['github', 'cloudflare'], initialConnected: ['github'] });
  assert.equal(await f.showTools(), 0);
  assert.ok(f.logs.some((line) => /GitHub.*connected/.test(line)));
  assert.ok(f.logs.some((line) => /Cloudflare.*connection not verified/.test(line)));
  assert.ok(f.logs.some((line) => /Supabase.*not installed/.test(line)));
  assert.equal(f.logs.some((line) => line.includes('test-user')), false);
});

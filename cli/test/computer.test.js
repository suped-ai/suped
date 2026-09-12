import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as computer from '../lib/computer.js';
import { main } from '../lib/cli.js';

// Replace only the OS boundary. Tests execute real CLI/runtime code without Docker.
function mockDocker(t, respond = () => ({})) {
  const original = childProcess.spawnSync;
  const calls = [];
  childProcess.spawnSync = (command, args, options) => {
    assert.equal(command, 'docker');
    calls.push({ args, options });
    return { status: 0, stdout: '', stderr: '', ...respond(args, options) };
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  });
  return calls;
}

function runningComputer(args, { saved = [], imageMissing = false, buildFails = false, legacy } = {}) {
  if (args[0] === 'version') return { stdout: 'linux' };
  if (args[0] === 'image' && args[1] === 'inspect') return { status: imageMissing ? 1 : 0 };
  if (args[0] === 'build') return { status: buildFails ? 1 : 0 };
  if (args[0] === 'container' && args[1] === 'inspect') {
    if (args[2] === '-f') {
      return { stdout: args[3] === '{{.State.Status}}' ? 'running' : computer.IMAGE };
    }
    return { stdout: JSON.stringify([legacy ?? { Config: { Labels: { 'dev.suped.run-args': JSON.stringify(saved) } } }]) };
  }
  return {};
}

function creationOptions(calls) {
  const run = calls.find(({ args }) => args[0] === 'run')?.args;
  assert.ok(run, 'replacement container should be created');
  const label = run[run.indexOf('--label') + 1];
  return JSON.parse(label.slice(label.indexOf('=') + 1));
}

test('exec forwards stdin and preserves exact argv through its login shell', (t) => {
  const calls = mockDocker(t, () => ({ status: 7 }));
  const command = ['printf', '%s', '', 'hello world', '$(touch unexpected)', 'a; b', 'line\nbreak'];
  assert.equal(computer.exec(command), 7);
  assert.ok(calls[0].args.includes('-i'));
  assert.deepEqual(calls[0].args.slice(-command.length - 4), ['bash', '-lc', 'exec "$@"', 'suped-exec', ...command]);
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('single shell strings retain pipes, expansion, and redirects', (t) => {
  const calls = mockDocker(t);
  const command = 'printf "%s\\n" "$HOME" | cat > ~/workspace/result.txt';
  computer.exec(command);
  assert.deepEqual(calls[0].args.slice(-3), ['bash', '-lc', command]);
});

test('capture forwards supplied JSON through stdin and preserves output whitespace', (t) => {
  const calls = mockDocker(t, () => ({ status: 2, stdout: '  result\n', stderr: ' warning\n' }));
  const input = JSON.stringify({ value: '$(touch unexpected)\n"quoted"' });
  assert.deepEqual(computer.capture(['cat'], { input }), { status: 2, stdout: '  result\n', stderr: ' warning\n' });
  assert.ok(calls[0].args.includes('-i'));
  assert.ok(!calls[0].args.includes('-it'));
  assert.ok(!calls[0].args.some((arg) => arg.includes(input)));
  assert.equal(calls[0].options.input, input);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('capture distinguishes empty input from no input', (t) => {
  const calls = mockDocker(t);
  computer.capture('cat', { input: '' });
  computer.capture('true');
  assert.ok(calls[0].args.includes('-i'));
  assert.equal(calls[0].options.input, '');
  assert.ok(!calls[1].args.includes('-i'));
  assert.deepEqual(calls[1].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('status does not inspect Docker resources when the executable is missing', (t) => {
  const calls = mockDocker(t, () => ({ error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }) }));
  const status = computer.status();
  assert.equal(status.docker, false);
  assert.equal(status.imageExists, null);
  assert.equal(status.volumeExists, null);
  assert.equal(status.state, null);
  assert.equal(calls.length, 1);
});

test('status does not inspect Docker resources when its daemon is unavailable', (t) => {
  const calls = mockDocker(t, () => ({ status: 1, stderr: 'Cannot connect to Docker daemon' }));
  assert.equal(computer.status().docker, false);
  assert.equal(calls.length, 1);
});

test('reset preserves saved ports and mounts without additional flags', (t) => {
  const saved = ['-p', '127.0.0.1:3000:3000', '-v', 'C:/my data:/home/suped/data:ro'];
  const calls = mockDocker(t, (args) => runningComputer(args, { saved }));
  computer.resetComputer();
  assert.deepEqual(creationOptions(calls), saved);
});

test('reset replaces supplied ports while preserving existing mounts', (t) => {
  const saved = ['-p', '3000:3000', '-p', '8080:80', '-v', '/data:/home/suped/data'];
  const calls = mockDocker(t, (args) => runningComputer(args, { saved }));
  computer.resetComputer({ runArgs: ['-p', '4000:3000'] });
  assert.deepEqual(creationOptions(calls), ['-v', '/data:/home/suped/data', '-p', '4000:3000']);
});

test('reset recovers mounts and bound IPs from computers created before saved labels', (t) => {
  const legacy = {
    HostConfig: {
      Binds: [`${computer.VOLUME}:${computer.HOME}`, 'C:/my data:/home/suped/data:ro', '/srv/cache:/cache'],
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3001' }], '53/udp': [{ HostIp: '::1', HostPort: '5353' }] },
    },
  };
  const calls = mockDocker(t, (args) => runningComputer(args, { legacy }));
  computer.resetComputer();
  assert.deepEqual(creationOptions(calls), [
    '-v', 'C:/my data:/home/suped/data:ro', '-v', '/srv/cache:/cache',
    '-p', '127.0.0.1:3001:3000/tcp', '-p', '[::1]:5353:53/udp',
  ]);
});

test('a failed replacement image build leaves the existing computer intact', (t) => {
  const calls = mockDocker(t, (args) => runningComputer(args, { imageMissing: true, buildFails: true }));
  assert.throws(() => computer.resetComputer(), /image build failed/);
  assert.ok(calls.some(({ args }) => args[0] === 'build'));
  assert.ok(!calls.some(({ args }) => args[0] === 'rm' || args[0] === 'stop' || args[0] === 'run'));
});

test('rebuild prepares its image before removal and preserves mount settings', (t) => {
  const saved = ['-v', '/data:/home/suped/data'];
  const calls = mockDocker(t, (args) => runningComputer(args, { saved }));
  computer.resetComputer({ rebuild: true, noCache: true });
  const build = calls.findIndex(({ args }) => args[0] === 'build');
  const remove = calls.findIndex(({ args }) => args[0] === 'rm');
  assert.ok(build >= 0 && build < remove);
  assert.ok(calls[build].args.includes('--no-cache'));
  assert.deepEqual(creationOptions(calls), saved);
});

test('creation flags on an existing computer produce an actionable warning', (t) => {
  mockDocker(t, runningComputer);
  const logs = [];
  computer.ensureUp({ runArgs: ['-p', '3000:3000'], log: (message) => logs.push(message) });
  assert.ok(logs.some((message) => /ignored.*suped reset/.test(message)));
});

test('CLI exec runs program version flags instead of printing the Suped version', async (t) => {
  const calls = mockDocker(t, runningComputer);
  assert.equal(await main(['exec', 'node', '--version']), 0);
  const execution = calls.find(({ args }) => args[0] === 'exec');
  assert.deepEqual(execution.args.slice(-6), ['bash', '-lc', 'exec "$@"', 'suped-exec', 'node', '--version']);
});

test('CLI exec retains the existing quoted shell-command interface', async (t) => {
  const calls = mockDocker(t, runningComputer);
  await main(['exec', 'echo saved > ~/workspace/saved.txt']);
  const execution = calls.find(({ args }) => args[0] === 'exec');
  assert.deepEqual(execution.args.slice(-3), ['bash', '-lc', 'echo saved > ~/workspace/saved.txt']);
});

// --- the home skeleton and its migration ---

const skeletonCalls = (calls) => calls.filter(({ args }) =>
  args.includes('bash') && args.some((arg) => typeof arg === 'string' && arg.startsWith('cd ~ && mkdir -p')));

test('the skeleton the image seeds and the one the CLI repairs cannot drift apart', async () => {
  // Two files have to name the same directories: the container's own init, for
  // a container started directly, and HOME_SKELETON, for a container that was
  // already running when Suped was upgraded. A mismatch is silent.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const read = (name) => readFileSync(fileURLToPath(new URL(`../docker/${name}`, import.meta.url)), 'utf8');
  for (const [name, pattern] of [['suped-init', /mkdir -p ([^\n]+)/], ['Dockerfile', /RUN mkdir -p ([^\\\n]+)/]]) {
    const listed = read(name).match(pattern)[1].trim().split(/\s+/);
    assert.deepEqual(listed, computer.HOME_SKELETON, `${name} must list exactly HOME_SKELETON`);
  }
});

test('a workspace that was already running gains missing directories on up, without touching anything', async (t) => {
  const calls = mockDocker(t, runningComputer);
  assert.equal(await main(['up']), 0);
  const repair = skeletonCalls(calls);
  assert.equal(repair.length, 1, 'up repairs the skeleton of a running workspace');
  const script = repair[0].args.at(-1);
  for (const dir of computer.HOME_SKELETON) assert.ok(script.includes(`'${dir}'`), dir);
  // mkdir -p only. Nothing that could remove or overwrite existing work.
  assert.doesNotMatch(script, /\brm\b|\bmv\b|>|rsync|chown|chmod/);
});

test('exec never pays for the skeleton repair', async (t) => {
  // An agent runs exec constantly; a Docker round trip per command is the cost
  // this deliberately avoids. A running container's init has already done it.
  const calls = mockDocker(t, runningComputer);
  await main(['exec', 'true']);
  assert.deepEqual(skeletonCalls(calls), [], 'exec must not add a Docker round trip');
});

test('a workspace that had to be started is repaired even without being asked', (t) => {
  // Its init may predate the directories, so starting it is not enough.
  const calls = mockDocker(t, (args) => (args[0] === 'container' && args[1] === 'inspect' && args[2] === '-f'
    && args[3] === '{{.State.Status}}' ? { stdout: 'exited' } : runningComputer(args)));
  computer.ensureUp({});
  assert.equal(skeletonCalls(calls).length, 1);
});

test('a replacement container has its skeleton ensured before it is used', (t) => {
  const calls = mockDocker(t, runningComputer);
  computer.resetComputer();
  assert.equal(skeletonCalls(calls).length, 1, 'reset ensures the skeleton');
});

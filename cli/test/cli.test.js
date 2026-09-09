import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli.js';
import { systemPrompt, VERSION } from '../lib/computer.js';
import { main } from '../lib/cli.js';

test('no args opens a shell', () => {
  const r = parseArgs([]);
  assert.equal(r.command, 'shell');
  assert.deepEqual(r.args, []);
  assert.deepEqual(r.runArgs, []);
});

test('exec collects the command line', () => {
  const r = parseArgs(['exec', 'ls', '-la', '/home/suped']);
  assert.equal(r.command, 'exec');
  assert.deepEqual(r.args, ['ls', '-la', '/home/suped']);
});

test('exec owns all following command flags, including Suped option names', () => {
  for (const command of [
    ['git', 'status', '--short'],
    ['python3', '-c', 'print("hello world")'],
    ['node', '--version'],
    ['curl', '-I', '--help', 'https://example.com'],
    ['app', '-p', '3000', '-v', 'file', '--yes'],
  ]) {
    const r = parseArgs(['exec', ...command]);
    assert.deepEqual(r.args, command);
    assert.equal(r.flags.size, 0);
    assert.deepEqual(r.runArgs, []);
  }
});

test('creation options before exec remain Suped options', () => {
  const r = parseArgs(['-p', '3000:3000', 'exec', 'node', '-p', 'process.version']);
  assert.deepEqual(r.runArgs, ['-p', '3000:3000']);
  assert.deepEqual(r.args, ['node', '-p', 'process.version']);
});

test('MCP owns its client options and help after the command', () => {
  const parsed = parseArgs(['mcp', 'add', 'notion', 'linear', '--client', 'codex']);
  assert.deepEqual(parsed.args, ['add', 'notion', 'linear', '--client', 'codex']);
  assert.equal(parsed.flags.size, 0);
  assert.deepEqual(parseArgs(['mcp', '--help']).args, ['--help']);
});

test('invalid setup selections fail before Docker is accessed', async () => {
  for (const command of ['setup', 'tools', 'login']) {
    await assert.rejects(main([command, 'not-a-provider']), /Unknown tool/);
  }
});

test('exec preserves empty arguments, whitespace, and shell metacharacters', () => {
  const args = ['printf', '%s', '', 'a b', '$(touch unwanted)', 'a; b', 'line\nbreak'];
  assert.deepEqual(parseArgs(['exec', ...args]).args, args);
  assert.deepEqual(parseArgs(['exec', 'echo first && echo second']).args, ['echo first && echo second']);
});

test('-- stops option parsing', () => {
  const r = parseArgs(['exec', '--', 'echo', '--yes']);
  assert.deepEqual(r.args, ['echo', '--yes']);
  assert.equal(r.flags.has('yes'), false);
});

test('ports and volumes become docker run args', () => {
  const r = parseArgs(['-p', '3000:3000', '--volume=C:/data:/home/suped/data', 'up']);
  assert.equal(r.command, 'up');
  assert.deepEqual(r.runArgs, ['-p', '3000:3000', '-v', 'C:/data:/home/suped/data']);
});

test('missing option value throws', () => {
  for (const args of [['-p'], ['--volume='], ['--publish='], ['-v', '--help']]) {
    assert.throws(() => parseArgs(args), /missing value/);
  }
});

test('setup collects tool selections and skip-auth without consuming tool names', () => {
  const r = parseArgs(['setup', 'github', 'supabase', '--skip-auth']);
  assert.equal(r.command, 'setup');
  assert.deepEqual(r.args, ['github', 'supabase']);
  assert.equal(r.flags.has('skip-auth'), true);
});

test('flags are collected', () => {
  const r = parseArgs(['destroy', '--yes']);
  assert.equal(r.command, 'destroy');
  assert.equal(r.flags.has('yes'), true);
});

test('system prompt is the short one', () => {
  const p = systemPrompt();
  assert.match(p, /^You are operating a persistent Linux computer/);
  assert.ok(p.split('\n').filter(Boolean).length <= 6, 'prompt should stay tiny');
});

test('version matches package.json', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

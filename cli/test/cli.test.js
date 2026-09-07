import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli.js';
import { systemPrompt, VERSION } from '../lib/computer.js';

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
  assert.throws(() => parseArgs(['-p']), /missing value/);
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

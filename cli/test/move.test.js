import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createMove, MANIFEST_NAME, SECRETS_NAME } from '../lib/move.js';

// Fakes for the two halves. What matters is that move composes them correctly:
// the right file to the right half, in the right order, and an honest summary.
function fixture({ syncResult = 0, secretsResult = 0, present = [MANIFEST_NAME, SECRETS_NAME] } = {}) {
  const logs = [];
  const calls = [];
  const made = [];
  const half = (name, result) => ({
    save: (file) => { calls.push([name, 'save', file]); return result; },
    restore: (file) => { calls.push([name, 'restore', file]); return result; },
    status: () => { calls.push([name, 'status']); return 0; },
  });
  const move = createMove({
    log: (message) => logs.push(message),
    makeSync: () => half('sync', syncResult),
    makeSecrets: () => half('secrets', secretsResult),
    exists: (path) => present.some((name) => path.endsWith(name)),
    makeDir: (path) => made.push(path),
  });
  return { move, logs, calls, made, output: () => logs.join('\n') };
}

test('save writes each half to its own file under one directory', async () => {
  const f = fixture();
  assert.equal(f.move.save('/tmp/ws'), 0);
  assert.deepEqual(f.made, ['/tmp/ws']);
  assert.deepEqual(f.calls, [
    ['sync', 'save', join('/tmp/ws', MANIFEST_NAME)],
    ['secrets', 'save', join('/tmp/ws', SECRETS_NAME)],
  ]);
});

test('a save that sealed credentials says the identity is not in the directory', () => {
  // Copying the directory and forgetting the key is the way this goes wrong,
  // so the instruction has to be in the output, not only in the documentation.
  const f = fixture({ secretsResult: 0 });
  f.move.save('/tmp/ws');
  assert.match(f.output(), /identity is deliberately not in this directory/);
  assert.match(f.output(), /safe to commit/);
});

test('a save with nothing to seal says so, and does not ask for an identity', () => {
  // A base workspace with nothing signed in is a complete move, not a failure.
  const f = fixture({ secretsResult: 1 });
  assert.equal(f.move.save('/tmp/ws'), 0);
  assert.match(f.output(), /No credentials were sealed/);
  assert.doesNotMatch(f.output(), /identity is deliberately not/);
  assert.match(f.output(), /suped login/);
});

test('restore refuses a directory that holds no workspace', async () => {
  const f = fixture({ present: [] });
  await assert.rejects(f.move.restore('/tmp/ws'), new RegExp(`no ${MANIFEST_NAME}`));
  assert.deepEqual(f.calls, [], 'nothing is restored from a directory without a manifest');
});

test('restore installs the workspace before signing anything in', async () => {
  // Order is not cosmetic: a tool has to exist before its credential can be
  // handed back to it.
  const f = fixture();
  assert.equal(await f.move.restore('/tmp/ws'), 0);
  assert.deepEqual(f.calls.map(([half]) => half), ['sync', 'secrets']);
});

test('restore without a sealed file still rebuilds the workspace, and says what is missing', async () => {
  const f = fixture({ present: [MANIFEST_NAME] });
  assert.equal(await f.move.restore('/tmp/ws'), 0);
  assert.deepEqual(f.calls, [['sync', 'restore', join('/tmp/ws', MANIFEST_NAME)]]);
  assert.match(f.output(), /no credentials came across/);
  assert.match(f.output(), /suped login/);
});

test('a failure in either half is reported rather than hidden by the other succeeding', async () => {
  for (const failing of ['syncResult', 'secretsResult']) {
    const f = fixture({ [failing]: 1 });
    assert.equal(await f.move.restore('/tmp/ws'), 1, failing);
    assert.match(f.output(), /did not complete/);
  }
  const clean = fixture();
  assert.equal(await clean.move.restore('/tmp/ws'), 0);
  assert.match(clean.output(), /Moved\./);
});

test('status asks both halves what would travel', () => {
  const f = fixture();
  assert.equal(f.move.status(), 0);
  assert.deepEqual(f.calls, [['sync', 'status'], ['secrets', 'status']]);
});

test('save and restore name a directory, not a file, when given nothing', async () => {
  const f = fixture();
  assert.throws(() => f.move.save(), /usage: suped move save <directory>/);
  await assert.rejects(f.move.restore(), /usage: suped move save <directory>/);
});

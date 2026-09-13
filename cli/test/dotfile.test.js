import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWorkspaceFile, findWorkspaceFile, parseWorkspaceFile } from '../lib/dotfile.js';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'suped-dotfile-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('the nearest .suped above the working directory is the one that applies', () => {
  const root = tree({ '.suped': 'container = outer\n', 'app/deep/.keep': '' });
  try {
    assert.equal(findWorkspaceFile(join(root, 'app/deep')), join(root, '.suped'));
    assert.equal(findWorkspaceFile(join(root, 'app')), join(root, '.suped'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a file is parsed as key = value with comments, and refuses what it does not know', () => {
  assert.deepEqual(parseWorkspaceFile('# the tuiaes box\ncontainer = suped-tuiaes\nvolume="suped-tuiaes-home"\ndir = projects/tuiaes  # where the repo is\n'),
    { container: 'suped-tuiaes', volume: 'suped-tuiaes-home', dir: 'projects/tuiaes' });
  assert.throws(() => parseWorkspaceFile('port = 3000\n'), /unknown key "port"/);
  assert.throws(() => parseWorkspaceFile('container\n'), /expected "key = value"/);
  assert.throws(() => parseWorkspaceFile('container = $(whoami)\n'), /unusable value for container/);
  assert.throws(() => parseWorkspaceFile('volume = a b\n'), /unusable value for volume/);
});

test('the file fills blanks in the environment and never overrides what is set', () => {
  const root = tree({ '.suped': 'container = from-file\nvolume = vol-from-file\ndir = projects/x\n' });
  try {
    const env = { SUPED_CONTAINER: 'from-env' };
    const found = applyWorkspaceFile({ cwd: root, env });
    assert.equal(env.SUPED_CONTAINER, 'from-env', 'an explicit variable wins');
    assert.equal(env.SUPED_VOLUME, 'vol-from-file');
    assert.equal(env.SUPED_DIR, 'projects/x');
    assert.equal(env.SUPED_WORKSPACE_FILE, join(root, '.suped'));
    assert.deepEqual(found.applied, { volume: 'vol-from-file', dir: 'projects/x' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no file means nothing changes', () => {
  const root = tree({ 'empty/.keep': '' });
  try {
    const env = {};
    assert.equal(applyWorkspaceFile({ cwd: join(root, 'empty'), env }), findWorkspaceFile(join(root, 'empty')) ? undefined : null);
    assert.equal(env.SUPED_WORKSPACE_FILE, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

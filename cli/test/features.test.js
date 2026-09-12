import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, normalizeFeatures, imageFor, VERSION } from '../lib/computer.js';
import { parseArgs } from '../lib/cli.js';

test('the catalogue of optional software is small and documented', () => {
  assert.deepEqual(Object.keys(FEATURES).sort(), ['browser', 'build', 'media']);
  for (const [name, entry] of Object.entries(FEATURES)) {
    assert.match(entry.arg, /^WITH_[A-Z]+$/, `${name} needs a build arg`);
    assert.ok(entry.summary.length > 10, `${name} needs a summary`);
  }
});

test('a selection normalizes to one canonical form', () => {
  assert.deepEqual(normalizeFeatures([]), []);
  assert.deepEqual(normalizeFeatures(), []);
  // Order, case and duplicates must not produce a different image.
  assert.deepEqual(normalizeFeatures(['media', 'browser']), ['browser', 'media']);
  assert.deepEqual(normalizeFeatures(['BROWSER', ' browser ', 'browser']), ['browser']);
  assert.deepEqual(normalizeFeatures(['', 'build']), ['build']);
});

test('an unknown feature is refused before anything is built', () => {
  assert.throws(() => normalizeFeatures(['rust']), /unknown feature rust/);
  assert.throws(() => normalizeFeatures(['browser', 'nope']), /choose from browser, build, media/);
});

test('the image tag carries the selection, so reset reproduces the same computer', () => {
  delete process.env.SUPED_IMAGE;
  assert.equal(imageFor([]), `suped-computer:${VERSION}`);
  assert.equal(imageFor(['browser']), `suped-computer:${VERSION}-browser`);
  // Two spellings of one selection must resolve to the same tag.
  assert.equal(imageFor(['media', 'browser']), imageFor(['browser', 'media']));
  assert.equal(imageFor(['browser', 'build', 'media']), `suped-computer:${VERSION}-browser.build.media`);
});

test('an explicit SUPED_IMAGE still wins', () => {
  process.env.SUPED_IMAGE = 'my-own:tag';
  try {
    assert.equal(imageFor([]), 'my-own:tag');
    assert.equal(imageFor(['browser']), 'my-own:tag');
  } finally {
    delete process.env.SUPED_IMAGE;
  }
});

test('--with collects features, comma or space separated', () => {
  assert.deepEqual(parseArgs(['--with', 'browser']).features, ['browser']);
  assert.deepEqual(parseArgs(['--with', 'browser,media']).features, ['browser', 'media']);
  assert.deepEqual(parseArgs(['--with=browser,build']).features, ['browser', 'build']);
  assert.deepEqual(parseArgs(['--with', 'browser', '--with', 'media']).features, ['browser', 'media']);
});

test('no --with means "leave the selection alone", which is not the same as none', () => {
  // null lets reset keep what the container already has; [] strips it.
  assert.equal(parseArgs(['reset']).features, null);
  assert.deepEqual(parseArgs(['reset', '--without']).features, []);
});

test('--with needs a value', () => {
  assert.throws(() => parseArgs(['--with']), /missing value for --with/);
  assert.throws(() => parseArgs(['--with', '-p']), /missing value for --with/);
  assert.throws(() => parseArgs(['--with=']), /missing value for --with/);
});

test('--with coexists with ports, mounts and the command', () => {
  const r = parseArgs(['--with', 'browser', '-p', '3000:3000', 'rebuild']);
  assert.equal(r.command, 'rebuild');
  assert.deepEqual(r.features, ['browser']);
  assert.deepEqual(r.runArgs, ['-p', '3000:3000']);
});

test('exec still owns everything after it, including --with', () => {
  const r = parseArgs(['exec', 'my-tool', '--with', 'sugar']);
  assert.equal(r.command, 'exec');
  assert.deepEqual(r.args, ['my-tool', '--with', 'sugar']);
  assert.equal(r.features, null);
});

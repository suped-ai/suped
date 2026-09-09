import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { binaryInstall, npmInstall, PREFIX, shellQuote } from '../lib/catalog/installers.js';

const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--noprofile', '--norc', '-c', 'exit 0'], { windowsHide: true }).status === 0;
const command = 'suped-test-bin';
const version = '1.2.3';
const packageName = '@suped-test/cli';
const npmRecipe = npmInstall({ id: 'test', packageName, version, command });
const oldExecutable = '#!/bin/bash\nprintf "%s\\n" "suped-test-bin 0.9.0"\n';

function withFixture(fn) {
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, 'suped-installers-test-'));
  const prefix = join(directory, 'prefix').replaceAll('\\', '/');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin', command), oldExecutable, { mode: 0o755 });
  try { return fn({ directory, prefix }); }
  finally {
    const child = relative(parent, resolve(directory));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'cleanup must stay within the allocated test directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

function binaryRecipe(format = 'tar.gz') {
  return binaryInstall({
    command, version, repository: 'suped-test/no-network',
    checksums: { amd64: '1'.repeat(64), arm64: '2'.repeat(64) },
    architectures: { amd64: 'x86_64', arm64: 'aarch64' },
    archive: `test_\${version}_\${arch}.${format}`, member: command, archiveFormat: format,
  });
}

function execute(recipe, fixture, { fail = '', arch = 'x86_64', packageVersion = version, executableVersion = version, before = '', env = {} } = {}) {
  // Downloads are inert. Filesystem operations are real and confined to the
  // allocated prefix, so failed activation can be checked against the old file.
  const script = `
mkdir() { command node -e 'for(const dir of process.argv.slice(1).filter(arg=>arg!=="-p"))require("node:fs").mkdirSync(dir,{recursive:true})' -- "$@"; }
mktemp() { command node -e 'const template=process.argv.at(-1);process.stdout.write(require("node:fs").mkdtempSync(template.replace(/X+$/,"")))' -- "$@"; }
uname() { printf '%s\\n' ${shellQuote(arch)}; }
curl() { printf 'CALLED:curl %s\\n' "$*" >&2; ${fail === 'curl' ? 'return 23' : 'return 0'}; }
sha256sum() { printf 'CALLED:sha256sum\\n' >&2; ${fail === 'sha256sum' ? 'return 23' : 'return 0'}; }
write_fake_executable() {
  printf '%s\\n' '#!/bin/bash' ${shellQuote(`printf '%s\\n' '${executableVersion}'`)} > "$1"
  chmod +x "$1"
}
tar() {
  printf 'CALLED:tar\\n' >&2
  ${fail === 'tar' ? 'return 23' : `write_fake_executable "$stage/${command}"`}
}
unzip() {
  printf 'CALLED:unzip\\n' >&2
  ${fail === 'unzip' ? 'return 23' : `write_fake_executable "$stage/${command}"`}
}
install() { printf 'CALLED:install\\n' >&2; ${fail === 'install' ? 'return 23' : 'command install "$@"'}; }
mv() { printf 'CALLED:mv\\n' >&2; ${fail === 'mv' ? 'return 23' : 'command mv "$@"'}; }
ln() { printf 'CALLED:ln\\n' >&2; ${fail === 'ln' ? 'return 23' : 'command ln "$@"'}; }
npm() {
  printf 'CALLED:npm %s\\n' "$*" >&2
  ${fail === 'npm' ? 'return 23' : `
  mkdir -p "$stage/node_modules/${packageName}" "$stage/node_modules/.bin"
  printf '%s\\n' ${shellQuote(JSON.stringify({ name: packageName, version: packageVersion }))} > "$stage/node_modules/${packageName}/package.json"
  write_fake_executable "$stage/node_modules/.bin/${command}"
  `}
}
${before}
${recipe.replace(`prefix=${shellQuote(PREFIX)}`, `prefix=${shellQuote(fixture.prefix)}`)}
`;
  return spawnSync(bash, ['--noprofile', '--norc', '-s'], {
    input: script, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function assertPreserved(fixture, run) {
  assert.equal(readFileSync(join(fixture.prefix, 'bin', command), 'utf8'), oldExecutable, run.stderr);
  assert.deepEqual(readdirSync(fixture.prefix).filter((name) => name.startsWith('.suped-')), [], 'binary staging directory is removed');
  const npmStages = join(fixture.prefix, 'share/suped/tools');
  if (existsSync(npmStages)) assert.deepEqual(readdirSync(npmStages), [], 'unsuccessful npm staging directory is removed');
}

test('tar and zip installers preserve the prior binary when download or checksum validation fails', { skip: !bashAvailable }, () => {
  for (const format of ['tar.gz', 'zip']) {
    for (const fail of ['curl', 'sha256sum']) withFixture((fixture) => {
      const run = execute(binaryRecipe(format), fixture, { fail });
      assert.equal(run.status, 23, run.stderr);
      assert.doesNotMatch(run.stderr, /CALLED:(tar|unzip|install|mv)/);
      assertPreserved(fixture, run);
    });
  }
});

test('extraction, installation, wrong-version, and activation failures cannot replace a working binary', { skip: !bashAvailable }, () => {
  for (const [format, extraction] of [['tar.gz', 'tar'], ['zip', 'unzip']]) {
    for (const fail of [extraction, 'install', 'mv']) withFixture((fixture) => {
      const run = execute(binaryRecipe(format), fixture, { fail });
      assert.equal(run.status, 23, run.stderr);
      assertPreserved(fixture, run);
    });
    withFixture((fixture) => {
      const run = execute(binaryRecipe(format), fixture, { executableVersion: '0.0.0' });
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stderr, /Unexpected .* version/);
      assert.doesNotMatch(run.stderr, /CALLED:mv/);
      assertPreserved(fixture, run);
    });
  }
});

test('shared binary installer maps architecture-specific assets and rejects unsupported CPUs before download', { skip: !bashAvailable }, () => {
  for (const [arch, asset] of [['x86_64', 'x86_64'], ['aarch64', 'aarch64']]) withFixture((fixture) => {
    const run = execute(binaryRecipe('zip'), fixture, { arch, fail: 'curl' });
    assert.equal(run.status, 23, run.stderr);
    assert.ok(run.stderr.includes(`test_${version}_${asset}.zip`), run.stderr);
  });
  withFixture((fixture) => {
    const run = execute(binaryRecipe(), fixture, { arch: 'riscv64' });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Unsupported CPU architecture/);
    assert.doesNotMatch(run.stderr, /CALLED:curl/);
    assertPreserved(fixture, run);
  });
});

test('npm failure and incorrect installed package metadata keep the previous executable and clean staging', { skip: !bashAvailable }, () => {
  withFixture((fixture) => {
    const run = execute(npmRecipe, fixture, { fail: 'npm' });
    assert.equal(run.status, 23, run.stderr);
    assert.doesNotMatch(run.stderr, /CALLED:(ln|mv)/);
    assertPreserved(fixture, run);
  });
  withFixture((fixture) => {
    const run = execute(npmRecipe, fixture, { packageVersion: '9.9.9' });
    assert.equal(run.status, 1, run.stderr);
    assert.doesNotMatch(run.stderr, /CALLED:(ln|mv)/);
    assertPreserved(fixture, run);
  });
});

test('npm link activation failure leaves the prior executable intact', { skip: !bashAvailable }, () => {
  for (const fail of ['ln', 'mv']) withFixture((fixture) => {
    const run = execute(npmRecipe, fixture, { fail });
    assert.equal(run.status, 23, run.stderr);
    assertPreserved(fixture, run);
  });
});

function withNativeDependency(fixture, packageVersion, fn) {
  const stage = join(fixture.prefix, 'share/suped/tools/previous');
  const inner = join(stage, 'node_modules/.bin', command);
  const native = join(stage, 'node_modules/@suped-test/cli-linux/bin', command);
  const metadata = join(stage, 'node_modules', packageName, 'package.json');
  mkdirSync(join(stage, 'node_modules', packageName), { recursive: true });
  writeFileSync(metadata, JSON.stringify({ name: packageName, version: packageVersion }));
  writeFileSync(join(fixture.prefix, 'bin', command), `#!/bin/bash\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  const runner = join(fixture.directory, 'metadata-runner.cjs');
  // Windows may forbid creating filesystem symlinks. Emulate only their two
  // read operations; run the installer's actual metadata program and real
  // package files. This models an npm bin pointing into an optional native
  // dependency, where realpath alone loses the owning package's location.
  writeFileSync(runner, `
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
if (process.argv[2] !== '-e') throw new Error('Unexpected node invocation');
const outer = path.resolve(process.env.SUPED_TEST_OUTER);
const inner = process.env.SUPED_TEST_INNER, native = process.env.SUPED_TEST_NATIVE;
const mockFs = { ...fs,
  readlinkSync(file) { return path.resolve(file) === outer ? inner : fs.readlinkSync(file); },
  realpathSync(file) { return path.resolve(file) === outer || path.resolve(file) === path.resolve(inner) ? native : fs.realpathSync(file); },
};
vm.runInNewContext(process.argv[3], {
  require: (name) => name === 'node:fs' ? mockFs : require(name),
  process: { argv: [process.execPath, ...process.argv.slice(4)], exit: (code) => process.exit(code) },
});
`);
  return fn({
    before: 'node() { command node "$SUPED_TEST_RUNNER" "$@"; }',
    env: { SUPED_TEST_RUNNER: runner, SUPED_TEST_OUTER: join(fixture.prefix, 'bin', command), SUPED_TEST_INNER: inner, SUPED_TEST_NATIVE: native },
  });
}

test('an npm executable backed by a platform-specific optional dependency is idempotent', { skip: !bashAvailable }, () => {
  withFixture((fixture) => withNativeDependency(fixture, version, (options) => {
    const run = execute(npmRecipe, fixture, { ...options, fail: 'npm' });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /CALLED:/, 'a current native dependency install must not download, relink, or reinstall');
  }));
});

test('optional native binary version alone cannot hide an outdated owning npm package', { skip: !bashAvailable }, () => {
  withFixture((fixture) => withNativeDependency(fixture, '0.8.0', (options) => {
    const prior = readFileSync(join(fixture.prefix, 'bin', command), 'utf8');
    const run = execute(npmRecipe, fixture, { ...options, fail: 'npm' });
    assert.equal(run.status, 23, run.stderr);
    assert.match(run.stderr, /CALLED:npm/);
    assert.doesNotMatch(run.stderr, /CALLED:(ln|mv)/);
    assert.equal(readFileSync(join(fixture.prefix, 'bin', command), 'utf8'), prior);
    assert.deepEqual(readdirSync(join(fixture.prefix, 'share/suped/tools')), ['previous']);
  }));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync, splitRunArgs, validateManifest, MANIFEST_VERSION } from '../lib/sync.js';

const PROJECTS = [
  { path: 'projects/blog', remote: 'https://github.com/me/blog.git', branch: 'main', dirty: false, unpushed: false },
  { path: 'projects/notes', remote: 'https://github.com/me/notes.git', branch: 'master', dirty: true, unpushed: false },
  { path: 'projects/scratch', remote: null, branch: 'main', dirty: false, unpushed: false },
  { path: 'workspace/spike', remote: 'https://github.com/me/spike.git', branch: 'main', dirty: false, unpushed: true },
];

function fixture({
  tools = ['github', 'cloudflare'],
  projects = PROJECTS,
  runArgs = ['-p', '3000:3000', '-v', '/host/data:/home/suped/data'],
  existing = [],
  files = {},
  failClone = null,
  installStatus = 0,
} = {}) {
  const logs = [];
  const calls = [];
  const written = {};
  let stdout = '';
  const installed = [];
  const instance = createSync({
    version: '0.2.0',
    log: (message) => logs.push(message),
    containerRunArgs: () => runArgs,
    capture: (command) => {
      calls.push(command);
      const script = command[2] ?? '';
      if (command[0] === 'node' && script.includes('setup.json')) {
        return { status: 0, stdout: JSON.stringify(tools === null ? null : { version: 1, tools, completed: true }), stderr: '' };
      }
      if (command[0] === 'node') return { status: 0, stdout: JSON.stringify(projects), stderr: '' };
      const match = /test -e "\$HOME\/(.+)"/.exec(script);
      if (match) return { status: existing.includes(match[1]) ? 0 : 1, stdout: '', stderr: '' };
      throw new assert.AssertionError({ message: `unexpected capture ${JSON.stringify(command)}` });
    },
    run: (command) => {
      calls.push(command);
      const script = command[2] ?? '';
      assert.match(script, /git clone/, `unexpected run ${script}`);
      return failClone && script.includes(failClone) ? 1 : 0;
    },
    readFile: (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
    writeFile: (file, text) => { written[file] = text; },
    write: (text) => { stdout += text; },
    installTools: async (ids) => { installed.push(...ids); return installStatus; },
  });
  return { ...instance, logs, calls, written, installed, stdout: () => stdout, text: () => logs.join('\n') };
}

test('run args split into ports and mounts', () => {
  assert.deepEqual(splitRunArgs(['-p', '80:80', '-v', '/a:/b', '-p', '443:443']),
    { ports: ['80:80', '443:443'], mounts: ['/a:/b'] });
  assert.deepEqual(splitRunArgs([]), { ports: [], mounts: [] });
  assert.deepEqual(splitRunArgs(), { ports: [], mounts: [] });
});

test('the manifest describes the workspace and never its credentials', () => {
  const f = fixture();
  const { manifest } = f.describe();
  assert.equal(manifest.version, MANIFEST_VERSION);
  assert.deepEqual(manifest.tools, ['github', 'cloudflare']);
  assert.deepEqual(manifest.ports, ['3000:3000']);
  assert.deepEqual(manifest.mounts, ['/host/data:/home/suped/data']);
  assert.deepEqual(manifest.projects, [
    { path: 'projects/blog', remote: 'https://github.com/me/blog.git', branch: 'main' },
    { path: 'projects/notes', remote: 'https://github.com/me/notes.git', branch: 'master' },
    { path: 'projects/scratch', remote: null, branch: 'main' },
    { path: 'workspace/spike', remote: 'https://github.com/me/spike.git', branch: 'main' },
  ]);
  // Nothing that could authenticate anything may appear in the file.
  const serialized = JSON.stringify(manifest);
  for (const word of ['token', 'secret', 'password', 'credential', 'dirty', 'unpushed']) {
    assert.equal(serialized.includes(word), false, `manifest must not carry "${word}"`);
  }
});

test('a base workspace with no selection still describes itself', () => {
  const f = fixture({ tools: null, projects: [], runArgs: [] });
  const { manifest, atRisk } = f.describe();
  assert.deepEqual(manifest.tools, []);
  assert.deepEqual(manifest.projects, []);
  assert.deepEqual(atRisk, []);
});

test('status reports work that would be left behind and exits nonzero', () => {
  const f = fixture();
  assert.equal(f.status(), 1);
  const text = f.text();
  assert.match(text, /would NOT move/);
  assert.match(text, /projects\/notes\s+uncommitted changes/);
  assert.match(text, /projects\/scratch\s+no remote/);
  assert.match(text, /workspace\/spike\s+commits not on any remote/);
  assert.equal(text.includes('projects/blog  '), true);
  assert.match(text, /Saved logins are not included/);
});

test('status is clean when everything is committed and pushed', () => {
  const f = fixture({ projects: [{ path: 'projects/blog', remote: 'https://x/y.git', branch: 'main', dirty: false, unpushed: false }] });
  assert.equal(f.status(), 0);
  assert.match(f.text(), /Nothing would be left behind/);
});

test('save writes the manifest to a file, and to stdout for "-"', () => {
  const f = fixture();
  assert.equal(f.save('/tmp/ws.json'), 0);
  const parsed = JSON.parse(f.written['/tmp/ws.json']);
  assert.equal(parsed.version, MANIFEST_VERSION);
  assert.deepEqual(parsed.tools, ['github', 'cloudflare']);
  assert.match(f.text(), /No credentials are in this file/);

  const g = fixture();
  assert.equal(g.save('-'), 0);
  assert.deepEqual(JSON.parse(g.stdout()).tools, ['github', 'cloudflare']);
  assert.equal(Object.keys(g.written).length, 0);
});

test('a bad manifest is rejected before anything is installed or cloned', () => {
  assert.throws(() => validateManifest(null), /expected an object/);
  assert.throws(() => validateManifest([]), /expected an object/);
  assert.throws(() => validateManifest({ version: 99 }), /unsupported version/);
  assert.throws(() => validateManifest({ version: 1, tools: 'github' }), /tools must be a list/);
  assert.throws(() => validateManifest({ version: 1, tools: [], ports: [], mounts: [], projects: {} }), /projects must be a list/);
  assert.throws(() => validateManifest({ version: 1, tools: [], ports: [], mounts: [], projects: [{ path: '' }] }), /needs a path/);
});

test('a manifest cannot clone outside the home', async () => {
  for (const path of ['/etc/cron.d/evil', '../../etc', 'projects/../../root']) {
    const manifest = { version: 1, tools: [], ports: [], mounts: [], projects: [{ path, remote: 'https://x/y.git', branch: 'main' }] };
    const f = fixture({ files: { 'ws.json': JSON.stringify(manifest) } });
    await assert.rejects(f.restore('ws.json'), /must stay inside the home/);
    assert.deepEqual(f.installed, []);
  }
});

test('restore installs the tools and clones only the projects that are missing', async () => {
  const manifest = {
    version: 1,
    tools: ['github'],
    ports: ['3000:3000'],
    mounts: [],
    projects: [
      { path: 'projects/blog', remote: 'https://github.com/me/blog.git', branch: 'main' },
      { path: 'projects/here', remote: 'https://github.com/me/here.git', branch: 'main' },
      { path: 'projects/scratch', remote: null, branch: 'main' },
    ],
  };
  const f = fixture({ files: { 'ws.json': JSON.stringify(manifest) }, existing: ['projects/here'] });
  assert.equal(await f.restore('ws.json'), 0);
  assert.deepEqual(f.installed, ['github']);

  const clones = f.calls.filter((command) => (command[2] ?? '').includes('git clone'));
  assert.equal(clones.length, 1, 'only the missing project is cloned');
  assert.match(clones[0][2], /--branch main "https:\/\/github\.com\/me\/blog\.git"/);
  assert.match(clones[0][2], /\$HOME\/projects\/blog/);

  const text = f.text();
  assert.match(text, /skipped ~\/projects\/here \(already here\)/);
  assert.match(text, /skipped ~\/projects\/scratch \(no remote recorded\)/);
  assert.match(text, /suped reset -p 3000:3000/);
  assert.match(text, /saved logins never travel/);
});

test('restore reports a failed clone without stopping the rest', async () => {
  const manifest = {
    version: 1,
    tools: [],
    ports: [],
    mounts: [],
    projects: [
      { path: 'projects/bad', remote: 'https://github.com/me/bad.git', branch: 'main' },
      { path: 'projects/good', remote: 'https://github.com/me/good.git', branch: 'main' },
    ],
  };
  const f = fixture({ files: { 'ws.json': JSON.stringify(manifest) }, failClone: 'bad.git' });
  assert.equal(await f.restore('ws.json'), 1);
  assert.match(f.text(), /skipped ~\/projects\/bad \(clone failed\)/);
  assert.match(f.text(), /Cloned 1 project/);
});

test('restore surfaces a failed tool installation', async () => {
  const manifest = { version: 1, tools: ['github'], ports: [], mounts: [], projects: [] };
  const f = fixture({ files: { 'ws.json': JSON.stringify(manifest) }, installStatus: 1 });
  assert.equal(await f.restore('ws.json'), 1);
});

test('restore needs a file', async () => {
  const f = fixture();
  await assert.rejects(f.restore(), /usage: suped sync restore/);
  await assert.rejects(f.restore('missing.json'), /could not read missing\.json/);
});

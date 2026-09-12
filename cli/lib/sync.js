// Move a workspace between machines. A workspace is defined by its tool
// selection, its published ports and extra mounts, and the repositories in it.
// All of that is small, portable text; none of it is a credential.
//
// This deliberately does not copy the home volume. That volume holds saved
// logins, architecture-specific binaries under ~/.local, and caches -- none of
// which should travel to another machine or into a git remote. Tools are
// reinstalled from the selection and projects are cloned from their remotes,
// so the rebuilt workspace matches the machine it lands on.

import { readFileSync, writeFileSync } from 'node:fs';
import * as computer from './computer.js';

export const MANIFEST_VERSION = 1;

// Runs in the computer. Reports every repository under ~/projects and
// ~/workspace, with whatever would not survive a move to another machine.
const SCAN_PROJECTS = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const home = require('node:os').homedir();
const found = [];
const git = (dir, args) => {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const walk = (rel, depth) => {
  const abs = path.join(home, rel);
  if (fs.existsSync(path.join(abs, '.git'))) {
    found.push({
      path: rel,
      remote: git(abs, ['remote', 'get-url', 'origin']) || null,
      branch: git(abs, ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
      dirty: git(abs, ['status', '--porcelain']) !== '',
      unpushed: git(abs, ['log', '--branches', '--not', '--remotes', '--format=%h']) !== '',
    });
    return;
  }
  if (depth <= 0) return;
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) walk(path.join(rel, entry.name), depth - 1);
  }
};
for (const root of ['projects', 'workspace']) walk(root, 2);
found.sort((a, b) => a.path.localeCompare(b.path));
process.stdout.write(JSON.stringify(found));
`;

const READ_SELECTION = `
const fs = require('node:fs');
const path = require('node:path').join(require('node:os').homedir(), '.config/suped/setup.json');
try { process.stdout.write(fs.readFileSync(path, 'utf8')); }
catch (error) { if (error.code === 'ENOENT') process.stdout.write('null'); else throw error; }
`;

// Runs in the computer. Reports software added after the workspace was created,
// by looking at what is installed rather than asking anyone to write it down.
// The agent installs things the ordinary way; nothing here is a convention it
// has to learn.
const SCAN_INSTALLED = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const home = require('node:os').homedir();
const run = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

// apt: everything explicitly installed now, minus what the image shipped with.
// The baseline is written when the container is created, before anyone adds to it.
const baselineFile = path.join(home, '.config/suped/base-packages');
let apt = [];
let aptKnown = false;
if (fs.existsSync(baselineFile)) {
  aptKnown = true;
  const baseline = new Set(fs.readFileSync(baselineFile, 'utf8').split('\\n').map((line) => line.trim()).filter(Boolean));
  apt = run('apt-mark', ['showmanual']).split('\\n').map((line) => line.trim())
    .filter((name) => name && !baseline.has(name)).sort();
}

// uv tools and npm globals live in the home, so they already survive a reset.
const uv = run('uv', ['tool', 'list']).split('\\n')
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('-'))
  .map((line) => line.split(/\\s+/)[0]).filter(Boolean).sort();

let npm = [];
try {
  const listed = JSON.parse(run('npm', ['ls', '-g', '--depth', '0', '--json', '--prefix', path.join(home, '.local')]) || '{}');
  npm = Object.entries(listed.dependencies || {})
    .map(([name, entry]) => (entry && entry.version ? name + '@' + entry.version : name)).sort();
} catch {}

process.stdout.write(JSON.stringify({ apt, aptKnown, uv, npm }));
`;

/** Split docker run args (['-p','a','-v','b']) into named lists. */
export function splitRunArgs(runArgs = []) {
  const ports = [];
  const mounts = [];
  for (let i = 0; i < runArgs.length; i += 2) {
    if (runArgs[i] === '-p') ports.push(runArgs[i + 1]);
    else if (runArgs[i] === '-v') mounts.push(runArgs[i + 1]);
  }
  return { ports, mounts };
}

export function validateManifest(manifest) {
  const fail = (why) => { throw new Error(`not a usable workspace file: ${why}`); };
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('expected an object');
  if (manifest.version !== MANIFEST_VERSION) fail(`unsupported version ${manifest.version}; this Suped writes version ${MANIFEST_VERSION}`);
  for (const key of ['tools', 'ports', 'mounts']) {
    if (!Array.isArray(manifest[key]) || manifest[key].some((value) => typeof value !== 'string')) fail(`${key} must be a list of strings`);
  }
  // Absent on version-1 files written before workspaces recorded their growth.
  const added = manifest.installed ?? {};
  if (added === null || typeof added !== 'object' || Array.isArray(added)) fail('installed must be an object');
  for (const key of ['apt', 'uv', 'npm']) {
    const list = added[key] ?? [];
    if (!Array.isArray(list) || list.some((value) => typeof value !== 'string')) fail(`installed.${key} must be a list of strings`);
    // These are pasted into a shell, so refuse anything that is not a package name.
    const bad = list.find((value) => !/^[A-Za-z0-9@._/+-]+$/.test(value));
    if (bad !== undefined) fail(`installed.${key} has an unusable package name: ${bad}`);
  }
  if (!Array.isArray(manifest.projects)) fail('projects must be a list');
  for (const project of manifest.projects) {
    if (project === null || typeof project !== 'object' || typeof project.path !== 'string' || !project.path) fail('each project needs a path');
    if (project.path.startsWith('/') || project.path.split('/').includes('..')) fail(`project path must stay inside the home: ${project.path}`);
    for (const key of ['remote', 'branch']) {
      if (project[key] !== null && project[key] !== undefined && typeof project[key] !== 'string') fail(`project ${key} must be a string or null`);
    }
  }
  return manifest;
}

export function createSync({
  capture = computer.capture,
  run = computer.exec,
  log = (message) => console.log(message),
  containerRunArgs = () => computer.containerRunArgs(),
  readFile = (file) => readFileSync(file, 'utf8'),
  writeFile = (file, text) => writeFileSync(file, text),
  write = (text) => process.stdout.write(text),
  installTools = async (tools) => (await import('./setup.js')).setup({ tools, authenticate: false, interactive: false }),
  version = computer.VERSION,
} = {}) {

  function selectedTools() {
    const result = capture(['node', '-e', READ_SELECTION]);
    if (result.status !== 0) throw new Error('could not read the tool selection; check that the computer is running');
    let config;
    try { config = JSON.parse(result.stdout); }
    catch { throw new Error('invalid ~/.config/suped/setup.json; repair that file and run "suped setup" again'); }
    return Array.isArray(config?.tools) ? config.tools : [];
  }

  function projects() {
    const result = capture(['node', '-e', SCAN_PROJECTS]);
    if (result.status !== 0) throw new Error('could not inspect your projects; check that the computer is running');
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('could not read the project list from the computer'); }
  }

  function installed() {
    const result = capture(['node', '-e', SCAN_INSTALLED]);
    if (result.status !== 0) throw new Error('could not inspect installed software; check that the computer is running');
    try {
      const found = JSON.parse(result.stdout);
      return { apt: found.apt ?? [], aptKnown: Boolean(found.aptKnown), uv: found.uv ?? [], npm: found.npm ?? [] };
    } catch { throw new Error('could not read the installed software list from the computer'); }
  }

  /** Everything that defines this workspace, and nothing that authenticates it. */
  function describe() {
    const found = projects();
    const added = installed();
    const { ports, mounts } = splitRunArgs(containerRunArgs());
    return {
      manifest: {
        version: MANIFEST_VERSION,
        suped: version,
        tools: selectedTools(),
        ports,
        mounts,
        // Software added after setup, so a workspace that grew keeps its growth.
        installed: { apt: added.apt, uv: added.uv, npm: added.npm },
        projects: found.map(({ path, remote, branch }) => ({ path, remote, branch })),
      },
      // Kept out of the manifest: this describes the machine you are leaving.
      atRisk: found.filter((project) => project.dirty || project.unpushed || !project.remote),
      aptKnown: added.aptKnown,
    };
  }

  function reportAtRisk(atRisk) {
    if (!atRisk.length) {
      log('\nEvery project is committed, pushed, and has a remote. Nothing would be left behind.');
      return 0;
    }
    log('\nThis work would NOT move. It lives only on this machine:');
    for (const project of atRisk) {
      const why = [
        !project.remote ? 'no remote' : null,
        project.dirty ? 'uncommitted changes' : null,
        // Without a remote every commit is unpushed, so saying both adds nothing.
        project.remote && project.unpushed ? 'commits not on any remote' : null,
      ].filter(Boolean).join(', ');
      log(`  ~/${project.path.padEnd(34)} ${why}`);
    }
    log('\nPush or commit these before you move, or copy them across yourself.');
    return 1;
  }

  /** Show what would travel, and what would be left behind. */
  function status() {
    const { manifest, atRisk, aptKnown } = describe();
    const added = manifest.installed;
    log(`Workspace ${computer.CONTAINER} (suped ${manifest.suped})\n`);
    log(`tools      ${manifest.tools.length ? manifest.tools.join(', ') : '(base workspace only)'}`);
    log(`ports      ${manifest.ports.length ? manifest.ports.join(', ') : '(none)'}`);
    log(`mounts     ${manifest.mounts.length ? manifest.mounts.join(', ') : '(none)'}`);
    if (added.uv.length) log(`uv tools   ${added.uv.join(', ')}`);
    if (added.npm.length) log(`npm global ${added.npm.join(', ')}`);
    if (added.apt.length) log(`apt        ${added.apt.join(', ')}`);
    else if (!aptKnown) log('apt        (not tracked; this workspace predates package tracking)');
    log(`projects   ${manifest.projects.length}`);
    for (const project of manifest.projects) {
      log(`  ~/${project.path.padEnd(34)} ${project.remote ? `${project.remote}${project.branch ? ` (${project.branch})` : ''}` : 'no remote'}`);
    }
    const risk = reportAtRisk(atRisk);
    if (added.apt.length) {
      log('\nThose apt packages do not survive "suped reset". They are recorded here, so');
      log('"suped sync restore" puts them back; prefer uv or a home npm prefix for anything you keep.');
    }
    log('\nSaved logins are not included. Connect accounts on the new machine with "suped login <tool>".');
    log('Write this workspace to a file with "suped sync save <file>".');
    return risk;
  }

  /** Write the manifest to a file on this computer, or to stdout for "-". */
  function save(file) {
    const { manifest, atRisk } = describe();
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (file === '-') write(text);
    else {
      writeFile(file, text);
      log(`wrote ${file}`);
      log(`${manifest.tools.length} tool(s), ${manifest.projects.length} project(s). No credentials are in this file; commit it anywhere you like.`);
    }
    if (file !== '-') reportAtRisk(atRisk);
    return 0;
  }

  /** Rebuild this workspace from a manifest: install its tools, clone its projects. */
  async function restore(file) {
    if (!file) throw new Error('usage: suped sync restore <file>');
    let manifest;
    try { manifest = JSON.parse(readFile(file)); }
    catch (error) { throw new Error(`could not read ${file}: ${error.message}`); }
    validateManifest(manifest);

    let failed = false;
    if (manifest.tools.length) {
      log(`Installing ${manifest.tools.length} tool(s) from the workspace file...`);
      if (await installTools(manifest.tools) !== 0) failed = true;
    } else {
      log('No tools to install; this was a base workspace.');
    }

    // Software the workspace grew after setup. Names are validated above, and
    // each installer is given them as arguments rather than interpolated text.
    const added = manifest.installed ?? {};
    const replays = [
      ['apt packages', added.apt ?? [], (names) => ['sudo', 'apt-get', 'install', '-y', '--no-install-recommends', ...names], true],
      ['uv tools', added.uv ?? [], (names) => ['uv', 'tool', 'install', ...names], false],
      ['npm globals', added.npm ?? [], (names) => ['npm', 'install', '-g', '--prefix', '/home/suped/.local', ...names], false],
    ];
    for (const [label, names, command, needsUpdate] of replays) {
      if (!names.length) continue;
      log(`Installing ${names.length} ${label}: ${names.join(', ')}`);
      if (needsUpdate && run(['sudo', 'apt-get', 'update']) !== 0) {
        log(`  could not refresh package lists; skipping ${label}`);
        failed = true;
        continue;
      }
      if (run(command(names)) !== 0) {
        log(`  some ${label} did not install; add them by hand`);
        failed = true;
      }
    }

    const cloned = [];
    const skipped = [];
    for (const project of manifest.projects) {
      if (!project.remote) { skipped.push([project.path, 'no remote recorded']); continue; }
      const target = `$HOME/${project.path}`;
      if (capture(['bash', '-lc', `test -e "${target}"`]).status === 0) {
        skipped.push([project.path, 'already here']);
        continue;
      }
      log(`Cloning ${project.remote} into ~/${project.path}...`);
      const branch = project.branch && project.branch !== 'HEAD' ? `--branch ${project.branch} ` : '';
      if (run(['bash', '-lc', `mkdir -p "$(dirname "${target}")" && git clone ${branch}"${project.remote}" "${target}"`]) !== 0) {
        skipped.push([project.path, 'clone failed']);
        failed = true;
        continue;
      }
      cloned.push(project.path);
    }

    log(`\nCloned ${cloned.length} project(s).`);
    for (const [path, why] of skipped) log(`  skipped ~/${path} (${why})`);
    if (manifest.ports.length || manifest.mounts.length) {
      const args = [...manifest.ports.flatMap((port) => ['-p', port]), ...manifest.mounts.flatMap((mount) => ['-v', mount])];
      log(`\nPorts and mounts are set when the container is created. To apply this workspace's:\n  suped reset ${args.join(' ')}`);
    }
    if (manifest.tools.length) log('\nConnect your accounts: suped login <tool>   (saved logins never travel in this file)');
    return failed ? 1 : 0;
  }

  return { status, save, restore, describe };
}

export async function mainSync(args, { runArgs = [] } = {}) {
  const [action = 'status', ...rest] = args;
  if (!['status', 'save', 'restore'].includes(action)) {
    throw new Error(`unknown sync command "${action}". Try: suped sync | suped sync save <file> | suped sync restore <file>`);
  }
  computer.ensureUp({ runArgs, log: (message) => console.error(`suped: ${message}`) });
  const sync = createSync();
  if (action === 'save') return sync.save(rest[0] ?? '-');
  if (action === 'restore') return sync.restore(rest[0]);
  return sync.status();
}

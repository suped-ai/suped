// Everything that touches Docker lives here. The "computer" is one container
// with one named volume mounted at /home/suped. Nothing else is special.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;

/**
 * Heavy software is opt-in and baked into the image rather than installed into
 * the container, because system packages do not survive `reset`. The selection
 * is part of the image tag, so reset and rebuild reproduce the same computer.
 */
export const FEATURES = {
  browser: { arg: 'WITH_BROWSER', summary: 'Playwright driving headless Chromium, for automation and JS-heavy pages' },
  build: { arg: 'WITH_BUILD', summary: 'a C toolchain, for packages that compile native extensions' },
  media: { arg: 'WITH_MEDIA', summary: 'ffmpeg and its codecs' },
};

/** Validate, lower-case, de-duplicate and sort, so one selection is one tag. */
export function normalizeFeatures(features = []) {
  const list = [...new Set(features.map((feature) => String(feature).trim().toLowerCase()).filter(Boolean))];
  const unknown = list.filter((feature) => !Object.hasOwn(FEATURES, feature));
  if (unknown.length) {
    throw new Error(`unknown feature ${unknown.join(', ')}; choose from ${Object.keys(FEATURES).join(', ')}`);
  }
  return list.sort();
}

/** An explicit SUPED_IMAGE always wins; otherwise the tag carries the selection. */
export function imageFor(features = []) {
  if (process.env.SUPED_IMAGE) return process.env.SUPED_IMAGE;
  const list = normalizeFeatures(features);
  return list.length ? `suped-computer:${VERSION}-${list.join('.')}` : `suped-computer:${VERSION}`;
}

export const IMAGE = imageFor();
export const CONTAINER = process.env.SUPED_CONTAINER || 'suped';
export const VOLUME = process.env.SUPED_VOLUME || 'suped-home';
export const HOME = '/home/suped';
export const WORKDIR = `${HOME}/workspace`;
export const USER = 'suped';

const DOCKER_DIR = fileURLToPath(new URL('../docker/', import.meta.url));
const RUN_ARGS_LABEL = 'dev.suped.run-args';
const FEATURES_LABEL = 'dev.suped.features';

export function systemPrompt() {
  return readFileSync(new URL('../docker/prompt.md', import.meta.url), 'utf8').trim();
}

function docker(args, { inherit = false, tty = false, input, trim = true } = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: !tty,
  });
  if (r.error) throw r.error;
  const output = (value) => trim ? (value ?? '').trim() : (value ?? '');
  return { status: r.status ?? 1, stdout: output(r.stdout), stderr: output(r.stderr) };
}

export function hasDocker() {
  try {
    return docker(['version', '--format', '{{.Server.Os}}']).status === 0;
  } catch {
    return false;
  }
}

export function imageExists(image = IMAGE) {
  return docker(['image', 'inspect', image]).status === 0;
}

export function buildImage(image = IMAGE, { noCache = false, features = [] } = {}) {
  const args = ['build', '-t', image];
  if (noCache) args.push('--no-cache');
  const selected = new Set(normalizeFeatures(features));
  for (const [name, { arg }] of Object.entries(FEATURES)) {
    args.push('--build-arg', `${arg}=${selected.has(name) ? '1' : '0'}`);
  }
  args.push(DOCKER_DIR);
  const r = docker(args, { inherit: true });
  if (r.status !== 0) throw new Error('image build failed');
}

export function volumeExists(volume = VOLUME) {
  return docker(['volume', 'inspect', volume]).status === 0;
}

export function createVolume(volume = VOLUME) {
  const r = docker(['volume', 'create', volume]);
  if (r.status !== 0) throw new Error(`could not create volume ${volume}: ${r.stderr}`);
}

/** 'running' | 'exited' | 'created' | 'paused' | ... | null when absent */
export function containerState(name = CONTAINER) {
  const r = docker(['container', 'inspect', '-f', '{{.State.Status}}', name]);
  return r.status === 0 ? r.stdout : null;
}

export function containerImage(name = CONTAINER) {
  const r = docker(['container', 'inspect', '-f', '{{.Config.Image}}', name]);
  return r.status === 0 ? r.stdout : null;
}

/** What was baked into this computer's image. Absent on pre-0.3.0 containers. */
export function containerFeatures(name = CONTAINER) {
  const r = docker(['container', 'inspect', '-f', `{{index .Config.Labels "${FEATURES_LABEL}"}}`, name]);
  if (r.status !== 0) return [];
  try { return normalizeFeatures(r.stdout.split(',')); }
  catch { return []; }
}

/** Recover the original CLI options, including computers created before labels. */
export function containerRunArgs(name = CONTAINER) {
  const r = docker(['container', 'inspect', name]);
  if (r.status !== 0) throw new Error(`could not inspect container ${name}: ${r.stderr}`);
  const [config] = JSON.parse(r.stdout);
  const saved = config.Config?.Labels?.[RUN_ARGS_LABEL];
  if (saved !== undefined) {
    const args = JSON.parse(saved);
    if (!Array.isArray(args) || args.length % 2 !== 0 || args.some((arg, i) =>
      typeof arg !== 'string' || (i % 2 === 0 && arg !== '-p' && arg !== '-v'))) {
      throw new Error('container has invalid saved port/mount settings');
    }
    return args;
  }
  const args = [];
  for (const bind of config.HostConfig?.Binds ?? []) {
    // Splitting from the right also handles a Windows drive letter in the source.
    const parts = bind.split(':');
    const destination = parts.at(-1).startsWith('/') ? parts.at(-1) : parts.at(-2);
    if (destination !== HOME) args.push('-v', bind);
  }
  for (const [port, bindings] of Object.entries(config.HostConfig?.PortBindings ?? {})) {
    for (const { HostIp = '', HostPort = '' } of bindings ?? []) {
      const host = HostIp.includes(':') ? `[${HostIp}]` : HostIp;
      args.push('-p', `${host ? `${host}:` : ''}${HostPort}:${port}`);
    }
  }
  return args;
}

function mergeRunArgs(saved, supplied) {
  const replaced = new Set(supplied.filter((_, index) => index % 2 === 0));
  return saved.filter((_, index) => !replaced.has(saved[index - index % 2])).concat(supplied);
}

/**
 * Create the container (does not attach). `runArgs` are extra `docker run`
 * flags, e.g. ['-p', '3000:3000', '-v', 'C:/data:/home/suped/data'].
 */
export function createContainer({ image = IMAGE, name = CONTAINER, volume = VOLUME, runArgs = [], features = [] } = {}) {
  const args = [
    'run', '-d',
    '--name', name,
    '--hostname', 'suped',
    '--init',
    '--restart', 'unless-stopped',
    '--label', `${RUN_ARGS_LABEL}=${JSON.stringify(runArgs)}`,
    '--label', `${FEATURES_LABEL}=${normalizeFeatures(features).join(',')}`,
    '-v', `${volume}:${HOME}`,
    '-w', WORKDIR,
    ...runArgs,
    image,
    // Starts cron, then waits. A computer created before 0.3.0 keeps running
    // `sleep infinity` until it is reset, and simply has no scheduler.
    'suped-init',
  ];
  const r = docker(args);
  if (r.status !== 0) throw new Error(`could not create container: ${r.stderr}`);
}

/**
 * Record the packages the image ships with, so `suped sync` can tell what was
 * added afterwards. Written once and kept in the home: a later container is
 * built from the same image, and an existing baseline is the older, truer one.
 */
export function recordBasePackages() {
  capture(['bash', '-lc',
    '[ -f ~/.config/suped/base-packages ] || { mkdir -p ~/.config/suped && apt-mark showmanual | sort > ~/.config/suped/base-packages; }']);
}

export function startContainer(name = CONTAINER) {
  const r = docker(['start', name]);
  if (r.status !== 0) throw new Error(`could not start container: ${r.stderr}`);
}

export function stopContainer(name = CONTAINER) {
  const r = docker(['stop', name]);
  if (r.status !== 0) throw new Error(`could not stop container: ${r.stderr}`);
}

export function removeContainer(name = CONTAINER) {
  const r = docker(['rm', '-f', name]);
  if (r.status !== 0) throw new Error(`could not remove container: ${r.stderr}`);
}

export function removeVolume(volume = VOLUME) {
  const r = docker(['volume', 'rm', volume]);
  if (r.status !== 0) throw new Error(`could not remove volume: ${r.stderr}`);
}

/**
 * Make sure image, volume and a running container exist.
 * Returns { created: boolean, built: boolean, stale: boolean }.
 */
export function ensureUp({ runArgs = [], features = [], log = () => {} } = {}) {
  if (!hasDocker()) {
    throw new Error('Docker is not available. Install Docker (https://docs.docker.com/get-docker/) and make sure the daemon is running.');
  }

  // An existing computer keeps the image it was built with; changing what is
  // baked in is a rebuild, not something a plain start should do behind you.
  const existing = containerState() !== null;
  const selected = normalizeFeatures(existing ? containerFeatures() : features);
  const image = imageFor(selected);

  let built = false;
  if (!imageExists(image)) {
    log(`building ${image} (first run; this takes a minute)`);
    buildImage(image, { features: selected });
    built = true;
  }

  if (!volumeExists()) {
    log(`creating persistent home volume ${VOLUME}`);
    createVolume();
  }

  let created = false;
  let stale = false;
  if (!existing) {
    log(`creating container ${CONTAINER}`);
    createContainer({ image, runArgs, features: selected });
    recordBasePackages();
    created = true;
  } else {
    if (runArgs.length) log('port/mount options were ignored because the computer already exists; use "suped reset" with those options to apply them');
    if (features.length && normalizeFeatures(features).join(',') !== selected.join(',')) {
      log(`--with was ignored because the computer already exists; use "suped rebuild --with ${normalizeFeatures(features).join(',')}" to change what is baked in`);
    }
    if (containerState() !== 'running') startContainer();
    stale = containerImage() !== image;
  }
  return { created, built, stale, image, features: selected };
}

/** Prepare the replacement before removing the computer; retain its connections. */
export function resetComputer({ runArgs = [], features = null, rebuild = false, noCache = false, log = () => {} } = {}) {
  if (!hasDocker()) throw new Error('Docker is not available. Make sure the daemon is running.');
  const state = containerState();
  const retainedArgs = mergeRunArgs(state === null ? [] : containerRunArgs(), runArgs);
  // Supplying --with replaces the selection; leaving it off keeps what is there.
  const selected = normalizeFeatures(features === null ? (state === null ? [] : containerFeatures()) : features);
  const image = imageFor(selected);
  if (rebuild || !imageExists(image)) {
    log(`${rebuild ? 'rebuilding' : 'building'} ${image}`);
    buildImage(image, { noCache, features: selected });
  }
  if (!volumeExists()) createVolume();
  if (state !== null) removeContainer();
  createContainer({ image, runArgs: retainedArgs, features: selected });
  recordBasePackages();
  return { image, features: selected };
}

function execArgs({ interactive = false, stdin = true } = {}) {
  const args = ['exec'];
  if (interactive) args.push('-it');
  else if (stdin) args.push('-i');
  args.push('-u', USER, '-w', WORKDIR);
  if (process.env.TERM) args.push('-e', `TERM=${process.env.TERM}`);
  args.push(CONTAINER);
  return args;
}

/** Attach an interactive login shell. Returns the shell's exit status. */
export function shell() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return docker([...execArgs({ interactive }), 'bash', '-l'], { inherit: true, tty: interactive }).status;
}

function commandArgs(command) {
  if (typeof command === 'string') return ['bash', '-lc', command];
  if (!Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== 'string')) {
    throw new Error('command must be a shell command string or a nonempty array of arguments');
  }
  // Login shell setup still runs, while positional parameters preserve every argv byte.
  return ['bash', '-lc', 'exec "$@"', 'suped-exec', ...command];
}

/** Run a shell string or exact argv inside the computer. Returns exit status. */
export function exec(command) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return docker([...execArgs({ interactive }), ...commandArgs(command)], { inherit: true, tty: interactive }).status;
}

/** Capture raw output without a TTY; input is delivered through stdin, never shell text. */
export function capture(command, { input } = {}) {
  return docker([...execArgs({ stdin: input !== undefined }), ...commandArgs(command)], { input, trim: false });
}

export function status() {
  const available = hasDocker();
  const state = available ? containerState() : null;
  const features = available && state !== null ? containerFeatures() : [];
  const image = imageFor(features);
  return {
    docker: available,
    image,
    imageExists: available ? imageExists(image) : null,
    volume: VOLUME,
    volumeExists: available ? volumeExists() : null,
    container: CONTAINER,
    state,
    containerImage: available ? containerImage() : null,
    features,
  };
}

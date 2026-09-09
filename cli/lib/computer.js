// Everything that touches Docker lives here. The "computer" is one container
// with one named volume mounted at /home/suped. Nothing else is special.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const IMAGE = process.env.SUPED_IMAGE || `suped-computer:${VERSION}`;
export const CONTAINER = process.env.SUPED_CONTAINER || 'suped';
export const VOLUME = process.env.SUPED_VOLUME || 'suped-home';
export const HOME = '/home/suped';
export const WORKDIR = `${HOME}/workspace`;
export const USER = 'suped';

const DOCKER_DIR = fileURLToPath(new URL('../docker/', import.meta.url));
const RUN_ARGS_LABEL = 'dev.suped.run-args';

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

export function buildImage(image = IMAGE, { noCache = false } = {}) {
  const args = ['build', '-t', image];
  if (noCache) args.push('--no-cache');
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
export function createContainer({ image = IMAGE, name = CONTAINER, volume = VOLUME, runArgs = [] } = {}) {
  const args = [
    'run', '-d',
    '--name', name,
    '--hostname', 'suped',
    '--init',
    '--restart', 'unless-stopped',
    '--label', `${RUN_ARGS_LABEL}=${JSON.stringify(runArgs)}`,
    '-v', `${volume}:${HOME}`,
    '-w', WORKDIR,
    ...runArgs,
    image,
    'sleep', 'infinity',
  ];
  const r = docker(args);
  if (r.status !== 0) throw new Error(`could not create container: ${r.stderr}`);
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
export function ensureUp({ runArgs = [], log = () => {} } = {}) {
  if (!hasDocker()) {
    throw new Error('Docker is not available. Install Docker (https://docs.docker.com/get-docker/) and make sure the daemon is running.');
  }

  let built = false;
  if (!imageExists()) {
    log(`building ${IMAGE} (first run; this takes a few minutes)`);
    buildImage();
    built = true;
  }

  if (!volumeExists()) {
    log(`creating persistent home volume ${VOLUME}`);
    createVolume();
  }

  let created = false;
  let stale = false;
  const state = containerState();
  if (state === null) {
    log(`creating container ${CONTAINER}`);
    createContainer({ runArgs });
    created = true;
  } else {
    if (runArgs.length) log('port/mount options were ignored because the computer already exists; use "suped reset" with those options to apply them');
    if (state !== 'running') startContainer();
    stale = containerImage() !== IMAGE;
  }
  return { created, built, stale };
}

/** Prepare the replacement before removing the computer; retain its connections. */
export function resetComputer({ runArgs = [], rebuild = false, noCache = false, log = () => {} } = {}) {
  if (!hasDocker()) throw new Error('Docker is not available. Make sure the daemon is running.');
  const state = containerState();
  const retainedArgs = mergeRunArgs(state === null ? [] : containerRunArgs(), runArgs);
  if (rebuild || !imageExists()) {
    log(`${rebuild ? 'rebuilding' : 'building'} ${IMAGE}`);
    buildImage(IMAGE, { noCache });
  }
  if (!volumeExists()) createVolume();
  if (state !== null) removeContainer();
  createContainer({ runArgs: retainedArgs });
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
  return {
    docker: available,
    image: IMAGE,
    imageExists: available ? imageExists() : null,
    volume: VOLUME,
    volumeExists: available ? volumeExists() : null,
    container: CONTAINER,
    state: available ? containerState() : null,
    containerImage: available ? containerImage() : null,
  };
}

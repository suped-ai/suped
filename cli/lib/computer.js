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

export function systemPrompt() {
  return readFileSync(new URL('../docker/prompt.md', import.meta.url), 'utf8').trim();
}

function docker(args, { inherit = false, tty = false } = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: !tty,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
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
    if (state !== 'running') startContainer();
    stale = containerImage() !== IMAGE;
  }
  return { created, built, stale };
}

function execArgs(interactive) {
  const args = ['exec'];
  if (interactive) args.push('-it');
  else if (process.stdin.isTTY === false) args.push('-i');
  args.push('-u', USER, '-w', WORKDIR);
  if (process.env.TERM) args.push('-e', `TERM=${process.env.TERM}`);
  args.push(CONTAINER);
  return args;
}

/** Attach an interactive login shell. Returns the shell's exit status. */
export function shell() {
  return docker([...execArgs(true), 'bash', '-l'], { inherit: true, tty: true }).status;
}

/** Run a shell command line inside the computer. Returns exit status. */
export function exec(commandLine) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return docker([...execArgs(interactive), 'bash', '-lc', commandLine], { inherit: true, tty: interactive }).status;
}

export function status() {
  return {
    docker: hasDocker(),
    image: IMAGE,
    imageExists: imageExists(),
    volume: VOLUME,
    volumeExists: volumeExists(),
    container: CONTAINER,
    state: containerState(),
    containerImage: containerImage(),
  };
}

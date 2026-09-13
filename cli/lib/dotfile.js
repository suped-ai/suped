// A `.suped` file names the workspace a directory belongs to.
//
// Driving a named workspace meant SUPED_CONTAINER and SUPED_VOLUME on every
// single command, and every project command started in ~/workspace and had to
// cd first. A file in the project directory (or any parent) settles both:
//
//   container = suped-tuiaes
//   volume    = suped-tuiaes-home
//   dir       = projects/tuiaes
//
// Keys become the matching SUPED_* variables. An explicit environment variable
// always wins over the file, so a repository cannot quietly redirect someone
// who set things up by hand -- the file only ever fills a blank.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const FILE_NAME = '.suped';
export const KEYS = { container: 'SUPED_CONTAINER', volume: 'SUPED_VOLUME', image: 'SUPED_IMAGE', dir: 'SUPED_DIR' };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9_.\/:-]*$/;

/** The nearest `.suped` at or above `start`, or null. */
export function findWorkspaceFile(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `key = value` lines, `#` comments. Unknown keys and unsafe values are errors, not surprises. */
export function parseWorkspaceFile(text, file = FILE_NAME) {
  const settings = {};
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`${file}:${index + 1}: expected "key = value", got "${raw.trim()}"`);
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in KEYS)) throw new Error(`${file}:${index + 1}: unknown key "${key}" (one of ${Object.keys(KEYS).join(', ')})`);
    const ok = key === 'image' ? IMAGE.test(value) : key === 'dir' ? value && !value.includes('\0') : NAME.test(value);
    if (!ok) throw new Error(`${file}:${index + 1}: unusable value for ${key}: "${value}"`);
    settings[key] = value;
  });
  return settings;
}

/**
 * Read the nearest workspace file into the environment, for whatever has not
 * been set there already. Returns what it found so status can say where the
 * names came from.
 */
export function applyWorkspaceFile({ cwd = process.cwd(), env = process.env } = {}) {
  const file = findWorkspaceFile(cwd);
  if (!file) return null;
  const settings = parseWorkspaceFile(readFileSync(file, 'utf8'), file);
  const applied = {};
  for (const [key, variable] of Object.entries(KEYS)) {
    if (settings[key] === undefined) continue;
    if (env[variable] !== undefined && env[variable] !== '') continue;
    env[variable] = settings[key];
    applied[key] = settings[key];
  }
  env.SUPED_WORKSPACE_FILE = file;
  return { file, settings, applied };
}

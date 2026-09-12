// Install optional workspace programs into the persistent home.
// Activate verified executables only after a complete successful installation.
export const PREFIX = '/home/suped/.local';
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function versionCheck(command, version, versionArgs, versionPattern) {
  const args = versionArgs.map(shellQuote).join(' ');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const check = versionPattern
    ? `case "$current" in ${versionPattern}) return 0 ;; *) return 1 ;; esac`
    : `printf '%s\\n' "$current" | grep -Eq ${shellQuote(`(^|[^[:alnum:].])v?${escaped}([^[:alnum:].-]|$)`)}`;
  return `version_matches() {
  local current
  current=$("$1" ${args} 2>&1) || return 1
  ${check}
}`;
}

export function npmInstall({ id, packageName, version, command, versionArgs = ['--version'] }) {
  // Follow our outer link before resolving npm's inner link: some packages
  // expose an executable from a platform-specific optional dependency.
  const metadataCheck = `const fs=require('node:fs'),p=require('node:path');
try { let dir=p.dirname(p.resolve(p.dirname(process.argv[1]),fs.readlinkSync(process.argv[1])));
for (;;) { const file=p.join(dir,'node_modules',process.argv[2],'package.json'); if(fs.existsSync(file)) {
const pkg=JSON.parse(fs.readFileSync(file,'utf8')); process.exit(pkg.name===process.argv[2]&&pkg.version===process.argv[3]?0:1);
} const next=p.dirname(dir); if(next===dir)break; dir=next; }
} catch {} process.exit(1);`;
  return `set -euo pipefail
prefix=${shellQuote(PREFIX)}
if [ -x "$prefix/bin/${command}" ] && node -e ${shellQuote(metadataCheck)} "$prefix/bin/${command}" ${shellQuote(packageName)} ${shellQuote(version)} && "$prefix/bin/${command}" ${versionArgs.map(shellQuote).join(' ')} >/dev/null 2>&1; then
  exit 0
fi
mkdir -p "$prefix/bin" "$prefix/share/suped/tools" "$prefix/share/suped/npm-cache"
stage=$(mktemp -d "$prefix/share/suped/tools/${id}-${version}.XXXXXX")
activated=false
trap 'if [ "$activated" = false ]; then rm -rf -- "$stage"; fi' EXIT
npm install --prefix "$stage" --cache "$prefix/share/suped/npm-cache" --no-audit --no-fund --save-exact ${shellQuote(`${packageName}@${version}`)}
node -e 'const p=require(process.argv[1]); if(p.version!==process.argv[2])process.exit(1)' "$stage/node_modules/${packageName}/package.json" ${shellQuote(version)}
"$stage/node_modules/.bin/${command}" ${versionArgs.map(shellQuote).join(' ')} >/dev/null
ln -s "$stage/node_modules/.bin/${command}" "$stage/${command}-link"
mv -fT -- "$stage/${command}-link" "$prefix/bin/${command}"
activated=true
`;
}

/**
 * A release that is the executable itself, with no archive around it. Same
 * guarantees as binaryInstall: the checksum is checked before anything runs,
 * the download has to report the version we asked for, and only then does it
 * replace what is on PATH.
 */
export function plainBinaryInstall({ command, version, downloadUrl, checksums,
  versionArgs = ['--version'], versionPattern, destination = '$prefix/bin',
  architectures = { amd64: 'x86_64', arm64: 'aarch64' } }) {
  return `set -euo pipefail
prefix=${shellQuote(PREFIX)}
version=${shellQuote(version)}
destination="${destination}"
${versionCheck(command, version, versionArgs, versionPattern)}
if [ -x "$destination/${command}" ] && version_matches "$destination/${command}"; then exit 0; fi
case "$(uname -m)" in
  x86_64|amd64) arch=${shellQuote(architectures.amd64)}; checksum=${shellQuote(checksums.amd64)} ;;
  aarch64|arm64) arch=${shellQuote(architectures.arm64)}; checksum=${shellQuote(checksums.arm64)} ;;
  *) printf 'Unsupported CPU architecture: %s\\n' "$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$destination"
stage=$(mktemp -d "$prefix/.suped-${command}.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 300 --output "$stage/${command}" "${downloadUrl}"
printf '%s  %s\\n' "$checksum" "$stage/${command}" | sha256sum --check --status
chmod 0755 "$stage/${command}"
if ! version_matches "$stage/${command}"; then printf 'Unexpected ${command} version.\\n' >&2; exit 1; fi
mv -fT -- "$stage/${command}" "$destination/${command}"
`;
}

export function binaryInstall({ command, version, repository, checksums, archive, member,
  versionArgs = ['--version'], versionPattern, downloadUrl, archiveFormat = 'tar.gz',
  architectures = { amd64: 'amd64', arm64: 'arm64' } }) {
  const url = downloadUrl || `https://github.com/${repository}/releases/download/v$version/$archive`;
  const extract = archiveFormat === 'zip'
    ? `unzip -q "$stage/archive" "${member}" -d "$stage"`
    : `tar --extract --gzip --file "$stage/archive" --directory "$stage" --no-same-owner "${member}"`;
  return `set -euo pipefail
prefix=${shellQuote(PREFIX)}
version=${shellQuote(version)}
${versionCheck(command, version, versionArgs, versionPattern)}
if [ -x "$prefix/bin/${command}" ] && version_matches "$prefix/bin/${command}"; then exit 0; fi
case "$(uname -m)" in
  x86_64|amd64) arch=${shellQuote(architectures.amd64)}; checksum=${shellQuote(checksums.amd64)} ;;
  aarch64|arm64) arch=${shellQuote(architectures.arm64)}; checksum=${shellQuote(checksums.arm64)} ;;
  *) printf 'Unsupported CPU architecture: %s\\n' "$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$prefix/bin"
stage=$(mktemp -d "$prefix/.suped-${command}.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
archive="${archive}"
curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 300 --output "$stage/archive" "${url}"
printf '%s  %s\\n' "$checksum" "$stage/archive" | sha256sum --check --status
${extract}
mkdir -p "$stage/verified"
install -m 0755 "$stage/${member}" "$stage/verified/${command}"
if ! version_matches "$stage/verified/${command}"; then printf 'Unexpected ${command} version.\\n' >&2; exit 1; fi
mv -fT -- "$stage/verified/${command}" "$prefix/bin/${command}"
`;
}

/**
 * An archive holding a whole toolchain rather than a single executable. The
 * tree is unpacked into a versioned directory inside the persistent home and
 * verified there; only then is each executable linked onto PATH. `bins` is
 * explicit, so adding a language cannot quietly put every script that happens
 * to ship in its archive on PATH.
 *
 * `provides` names executables that `postInstall` is responsible for creating.
 * They are checked alongside the version, so an install whose postInstall step
 * failed is retried rather than mistaken for a complete one.
 */
export function toolchainInstall({ id, command, version, repository, downloadUrl, checksums,
  archive, strip = 1, binDir = 'bin', bins = [command], provides = [], postInstall = '',
  versionArgs = ['--version'], versionPattern,
  architectures = { amd64: 'x86_64', arm64: 'aarch64' } }) {
  const url = downloadUrl || `https://github.com/${repository}/releases/download/v$version/$archive`;
  const inside = (dir) => (binDir === '.' ? dir : `${dir}/${binDir}`);
  const ready = [`[ -x "$prefix/bin/${command}" ]`, `version_matches "$prefix/bin/${command}"`,
    ...provides.map((name) => `[ -x "$prefix/bin/${name}" ]`)].join(' && ');
  return `set -euo pipefail
prefix=${shellQuote(PREFIX)}
version=${shellQuote(version)}
root="$prefix/share/suped/toolchains/${id}-$version"
${versionCheck(command, version, versionArgs, versionPattern)}
link_bins() {
  local tmp="$1" name
  for name in ${bins.map(shellQuote).join(' ')}; do
    ln -s "${inside('$root')}/$name" "$tmp/$name.link"
    mv -fT -- "$tmp/$name.link" "$prefix/bin/$name"
  done
}
if ${ready}; then exit 0; fi
case "$(uname -m)" in
  x86_64|amd64) arch=${shellQuote(architectures.amd64)}; checksum=${shellQuote(checksums.amd64)} ;;
  aarch64|arm64) arch=${shellQuote(architectures.arm64)}; checksum=${shellQuote(checksums.arm64)} ;;
  *) printf 'Unsupported CPU architecture: %s\\n' "$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$prefix/bin" "$prefix/share/suped/toolchains"
stage=$(mktemp -d "$prefix/share/suped/toolchains/.${id}.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
archive="${archive}"
curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 900 --output "$stage/archive" "${url}"
printf '%s  %s\\n' "$checksum" "$stage/archive" | sha256sum --check --status
mkdir -p "$stage/root"
tar --extract --gzip --file "$stage/archive" --directory "$stage/root" --no-same-owner --strip-components=${strip}
rm -f -- "$stage/archive"
if ! version_matches "${inside('$stage/root')}/${command}"; then printf 'Unexpected ${command} version.\\n' >&2; exit 1; fi
rm -rf -- "$root"
mv -fT -- "$stage/root" "$root"
link_bins "$stage"
${postInstall}`;
}

export function jsonOutput(result) {
  if (result?.status !== 0 || typeof result.stdout !== 'string') return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

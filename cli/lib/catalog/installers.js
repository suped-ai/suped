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

export function jsonOutput(result) {
  if (result?.status !== 0 || typeof result.stdout !== 'string') return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

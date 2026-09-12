// Optional human setup choices. Agents use the installed CLIs directly.
// Keep every executable and npm dependency in the persistent home volume.
import { DEPLOY_TOOLS } from './catalog/deploy.js';
import { SERVICE_TOOLS } from './catalog/services.js';
import { AGENT_TOOLS } from './catalog/agents.js';

export const CATEGORIES = [
  { id: 'source', name: 'Repositories' },
  { id: 'hosting', name: 'Hosting and deployment' },
  { id: 'database', name: 'Databases and app backends' },
  { id: 'cloud', name: 'Cloud infrastructure' },
  { id: 'payments', name: 'Payments' },
  { id: 'agents', name: 'Agent clients' },
];

const PREFIX = '/home/suped/.local';

function versionCheck(command, version) {
  const pattern = command === 'gh' ? `"gh version ${version}"|"gh version ${version} "*` : `"${version}"`;
  return `version_matches() {
  local current
  current=$("$1" --version 2>/dev/null) || return 1
  case "$current" in
    ${pattern}) return 0 ;;
    *) return 1 ;;
  esac
}`;
}

function binaryInstall({ command, version, repository, checksums, archive, member }) {
  return `set -euo pipefail
prefix='${PREFIX}'
version='${version}'
${versionCheck(command, version)}
if [ -x "$prefix/bin/${command}" ] && version_matches "$prefix/bin/${command}"; then
  exit 0
fi
case "$(uname -m)" in
  x86_64|amd64) arch=amd64; checksum='${checksums.amd64}' ;;
  aarch64|arm64) arch=arm64; checksum='${checksums.arm64}' ;;
  *) printf 'Unsupported CPU architecture: %s\\n' "$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$prefix/bin"
stage=$(mktemp -d "$prefix/.suped-${command}.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
archive="${archive}"
curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 300 \\
  --output "$stage/archive.tar.gz" "https://github.com/${repository}/releases/download/v$version/$archive"
printf '%s  %s\\n' "$checksum" "$stage/archive.tar.gz" | sha256sum --check --status
tar --extract --gzip --file "$stage/archive.tar.gz" --directory "$stage" --no-same-owner "${member}"
mkdir -p "$stage/bin"
install -m 0755 "$stage/${member}" "$stage/bin/${command}"
if ! version_matches "$stage/bin/${command}"; then
  printf 'Downloaded ${command} did not report expected version ${version}.\\n' >&2
  exit 1
fi
mv -fT -- "$stage/bin/${command}" "$prefix/bin/${command}"
`;
}

function wranglerInstall() {
  // Use a fresh private npm prefix so a failed upgrade leaves the working CLI
  // untouched. Only the final symlink replacement makes this install active.
  return `set -euo pipefail
prefix='${PREFIX}'
${versionCheck('wrangler', '4.119.0')}
if [ -x "$prefix/bin/wrangler" ] && version_matches "$prefix/bin/wrangler"; then
  exit 0
fi
mkdir -p "$prefix/bin" "$prefix/share/suped/tools" "$prefix/share/suped/npm-cache"
stage=$(mktemp -d "$prefix/share/suped/tools/wrangler-4.119.0.XXXXXX")
activated=false
trap 'if [ "$activated" = false ]; then rm -rf -- "$stage"; fi' EXIT
npm install --prefix "$stage" --cache "$prefix/share/suped/npm-cache" \\
  --no-audit --no-fund --save-exact wrangler@4.119.0
if ! version_matches "$stage/node_modules/.bin/wrangler"; then
  printf 'Installed wrangler did not report expected version 4.119.0.\\n' >&2
  exit 1
fi
ln -s "$stage/node_modules/.bin/wrangler" "$stage/wrangler-link"
mv -fT -- "$stage/wrangler-link" "$prefix/bin/wrangler"
activated=true
`;
}

function jsonOutput(result) {
  if (result?.status !== 0 || typeof result.stdout !== 'string') return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export const TOOLS = [
  {
    id: 'github',
    category: 'source', version: '2.100.0', docs: 'https://cli.github.com/manual/',
    name: 'GitHub',
    description: 'Repositories, issues, pull requests, and Git authentication with gh.',
    command: 'gh',
    // Official release asset SHA-256 values, checked September 8, 2026:
    // https://github.com/cli/cli/releases/expanded_assets/v2.100.0
    install: binaryInstall({
      command: 'gh',
      version: '2.100.0',
      repository: 'cli/cli',
      checksums: {
        amd64: 'e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be',
        arm64: 'ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961',
      },
      archive: 'gh_${version}_linux_${arch}.tar.gz',
      member: 'gh_${version}_linux_${arch}/bin/gh',
    }),
    // GH_BROWSER prints the device URL instead of attempting a container browser.
    // https://cli.github.com/manual/gh_auth_login
    login: ['env', 'GH_BROWSER=echo', 'gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
    afterLogin: ['gh', 'auth', 'setup-git', '--hostname', 'github.com'],
    authInstructions: 'GitHub will display a one-time code. Press Enter when prompted, then open the printed URL in your browser and enter the code.',
    check: ['gh', 'api', '--hostname', 'github.com', 'user'],
    connected(result) {
      const user = jsonOutput(result);
      return Boolean(user && Number.isInteger(user.id) && user.id > 0 && typeof user.login === 'string' && user.login.length > 0);
    },
    // Read the token back out and hand it to another machine's gh. This uses
    // the provider's own supported path rather than copying whatever file gh
    // happened to use: it stores the token in the system keyring where one
    // exists and in hosts.yml where one does not, so the file to copy is not
    // the same on every machine. `export` prints the secret on stdout;
    // `import` reads it on stdin.
    secret: {
      export: ['gh', 'auth', 'token', '--hostname', 'github.com'],
      import: ['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'],
    },
  },
  {
    id: 'cloudflare',
    category: 'hosting', version: '4.119.0', docs: 'https://developers.cloudflare.com/workers/wrangler/',
    name: 'Cloudflare',
    description: 'Workers, Pages, and Cloudflare services with Wrangler.',
    command: 'wrangler',
    install: wranglerInstall(),
    // Device authorization avoids a localhost callback inside the container.
    // https://developers.cloudflare.com/changelog/post/2026-08-04-wrangler-login-device-flow/
    login: ['wrangler', 'login', '--device', '--browser=false'],
    authInstructions: 'Open the verification URL Wrangler prints in your browser, enter its one-time code, and approve access before the code expires.',
    // Plain whoami can exit 0 while logged out. The pinned release supports JSON.
    check: ['wrangler', 'whoami', '--json'],
    connected(result) {
      return jsonOutput(result)?.loggedIn === true;
    },
  },
  {
    id: 'supabase',
    category: 'database', version: '2.117.0', docs: 'https://supabase.com/docs/reference/cli/introduction',
    name: 'Supabase',
    description: 'Hosted projects, migrations, and functions with the Supabase CLI.',
    command: 'supabase',
    // Standalone installation; npm install -g supabase is unsupported.
    // Official release asset SHA-256 values, checked September 8, 2026:
    // https://github.com/supabase/cli/releases/expanded_assets/v2.117.0
    install: binaryInstall({
      command: 'supabase',
      version: '2.117.0',
      repository: 'supabase/cli',
      checksums: {
        amd64: '69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24',
        arm64: '598c56a936fdf179ea486717901e6e49bc5d777b3ad317eab02f41faf21a95cb',
      },
      archive: 'supabase_${version}_linux_${arch}.tar.gz',
      member: 'supabase',
    }),
    // https://supabase.com/docs/reference/cli/supabase-login
    login: ['supabase', 'login', '--no-browser'],
    authInstructions: 'Follow the Supabase CLI login instructions. Open its printed link in your browser and enter any verification code in the CLI when prompted.',
    check: ['supabase', 'projects', 'list', '--output', 'json'],
    connected(result) {
      // An authenticated account can legitimately have no projects yet.
      return Array.isArray(jsonOutput(result));
    },
  },
  ...DEPLOY_TOOLS,
  ...SERVICE_TOOLS,
  ...AGENT_TOOLS,
];

const byId = new Map(TOOLS.map((tool) => [tool.id, tool]));
const aliases = new Map(TOOLS.flatMap((tool) => [tool.command, ...(tool.aliases || [])].map((alias) => [alias, tool.id])));

/** Resolve the entire selection before a caller starts installation or login. */
export function getTools(ids = []) {
  if (typeof ids === 'string') ids = ids.split(',');
  if (!Array.isArray(ids)) throw new TypeError('Tool selection must be a list of tool names.');
  if (!ids.every((id) => typeof id === 'string')) throw new TypeError('Tool names must be strings.');
  const selected = ids.flatMap((id) => id.split(',')).map((id) => {
    if (typeof id !== 'string') throw new TypeError('Tool names must be strings.');
    const normalized = id.trim().toLowerCase();
    const tool = byId.get(aliases.get(normalized) || normalized);
    if (!tool) throw new Error(`Unknown tool "${id}". Run "suped catalog" to see available tools.`);
    return tool;
  });
  return [...new Set(selected)];
}

export function showCatalog(log = console.log) {
  log('Choose what belongs in your workspace. Tools are installed only when selected.');
  for (const category of CATEGORIES) {
    log(`\n${category.name}`);
    for (const tool of TOOLS.filter((entry) => entry.category === category.id)) {
      log(`  ${tool.id.padEnd(12)} ${tool.name} (${tool.command}, ${tool.version}) — ${tool.description}`);
      if (!tool.login || tool.manualConnect) log('               Manual account connection: suped login ' + tool.id);
    }
  }
  log('\nGuided setup: suped setup     Choose directly: suped setup gitlab vercel neon');
  log('App connections: suped mcp list     Installed tools: suped tools');
  return 0;
}

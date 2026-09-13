// Language toolchains for the work an agent does locally: running scripts,
// building, testing. Each one is pinned and checksum-verified, and unpacks
// into the persistent home rather than the image, so picking up a language
// later never means rebuilding the workspace.
import { shellQuote, binaryInstall, toolchainInstall } from './installers.js';

const UV_VERSION = '0.12.13';
const PYTHON_VERSION = '3.14.7';
const GO_VERSION = '1.27.1';
const DENO_VERSION = '2.9.6';
const BUN_VERSION = '1.4.2';
const NODE_VERSION = '26.8.2';

// uv installs the interpreter and its shims itself. Name both directories
// explicitly: uv reads XDG_BIN_HOME and XDG_DATA_HOME ahead of HOME, so on a
// workspace where those are set Python would otherwise land outside the volume
// that persists.
//
// The interpreter goes under its own "uv" directory rather than beside the
// other runtimes. uv migrates a directory named "toolchains" that sits next to
// its install directory, because that was uv's own former name for it, so
// nothing else of ours should share that parent.
const installPython = `export UV_PYTHON_INSTALL_DIR="$prefix/share/suped/uv/python"
export UV_PYTHON_BIN_DIR="$prefix/bin"
"$prefix/bin/uv" python install --preview-features python-install-default --default ${shellQuote(PYTHON_VERSION)}
`;

export const LANGUAGE_TOOLS = [
  {
    id: 'node', name: 'Node.js', category: 'languages', command: 'node', version: NODE_VERSION,
    description: `Node.js ${NODE_VERSION} with npm and npx, ahead of the Node 22 the image ships.`,
    docs: 'https://nodejs.org/docs/latest-v26.x/api/',
    account: false,
    // The image carries Node 22 because setup installs agent clients and
    // several provider CLIs with npm, and that has to exist before any
    // selection runs. Projects often need a newer one -- TUIaes runs .ts files
    // directly, which needs native type stripping -- and could not choose it.
    // Official SHASUMS256.txt values, checked September 13, 2026:
    // https://nodejs.org/dist/v26.8.2/SHASUMS256.txt
    install: toolchainInstall({
      id: 'node', command: 'node', version: NODE_VERSION,
      downloadUrl: 'https://nodejs.org/dist/v$version/$archive',
      archive: 'node-v$version-linux-$arch.tar.gz',
      architectures: { amd64: 'x64', arm64: 'arm64' },
      checksums: {
        amd64: 'badb3fe6a61b85e1352ca6564dc56b8b7bd5ecd5c474c52acc21dd0cdd586f35',
        arm64: '746cdbf21565b4ea06f77642bb0e85466de8bb722242be2c5e006f272c361c63',
      },
      bins: ['node', 'npm', 'npx'],
    }),
  },
  {
    id: 'python', name: 'Python', category: 'languages',
    command: 'python3', aliases: ['python'], version: PYTHON_VERSION,
    description: `CPython ${PYTHON_VERSION} with uv and uvx for packages, virtual environments, and scripts.`,
    docs: 'https://docs.astral.sh/uv/',
    account: false,
    // Only uv is pinned here. It fetches the interpreter itself, against its
    // own published hashes, which keeps one download in this file instead of a
    // CPython build per architecture.
    // uv release asset SHA-256 values, checked September 12, 2026:
    // https://github.com/astral-sh/uv/releases/tag/0.12.13
    install: toolchainInstall({
      id: 'uv', command: 'uv', version: UV_VERSION,
      downloadUrl: 'https://github.com/astral-sh/uv/releases/download/$version/$archive',
      archive: 'uv-$arch-unknown-linux-gnu.tar.gz',
      checksums: {
        amd64: '745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd',
        arm64: '2eaa5d94f5db7b3a1a092156b9420459e42ab0217d917fe74a876309cef9b5e9',
      },
      // The archive is the two executables, with no bin directory around them.
      binDir: '.', bins: ['uv', 'uvx'],
      provides: ['python3', 'python'],
      postInstall: installPython,
    }),
  },
  {
    id: 'go', name: 'Go', category: 'languages', command: 'go', version: GO_VERSION,
    description: 'The Go toolchain: build, test, and module management with go and gofmt.',
    docs: 'https://go.dev/doc/',
    account: false,
    versionArgs: ['version'],
    // Official release SHA-256 values, checked September 12, 2026:
    // https://go.dev/dl/?mode=json
    install: toolchainInstall({
      id: 'go', command: 'go', version: GO_VERSION,
      downloadUrl: 'https://go.dev/dl/$archive',
      archive: 'go$version.linux-$arch.tar.gz',
      architectures: { amd64: 'amd64', arm64: 'arm64' },
      checksums: {
        amd64: '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445',
        arm64: '3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec',
      },
      // go locates its own GOROOT through the symlink, so linking the two
      // executables is enough; the tree stays where it was unpacked.
      bins: ['go', 'gofmt'],
      versionArgs: ['version'],
      versionPattern: `"go version go${GO_VERSION} "*`,
    }),
  },
  {
    id: 'deno', name: 'Deno', category: 'languages', command: 'deno', version: DENO_VERSION,
    description: 'JavaScript and TypeScript runtime with a formatter, linter, and test runner built in.',
    docs: 'https://docs.deno.com/runtime/',
    account: false,
    // Official release asset SHA-256 values, checked September 12, 2026:
    // https://github.com/denoland/deno/releases/expanded_assets/v2.9.6
    install: binaryInstall({
      command: 'deno', version: DENO_VERSION, repository: 'denoland/deno',
      archive: 'deno-$arch-unknown-linux-gnu.zip', archiveFormat: 'zip', member: 'deno',
      architectures: { amd64: 'x86_64', arm64: 'aarch64' },
      checksums: {
        amd64: '394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2',
        arm64: '9a46afc6c392c7cd2ff71a31558935545b46408d0e87f7a86908c712721c046e',
      },
    }),
  },
  {
    id: 'bun', name: 'Bun', category: 'languages', command: 'bun', version: BUN_VERSION,
    description: 'JavaScript and TypeScript runtime with a fast npm-compatible package manager.',
    docs: 'https://bun.com/docs',
    account: false,
    // Official release asset SHA-256 values, checked September 12, 2026:
    // https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt
    install: binaryInstall({
      command: 'bun', version: BUN_VERSION,
      // Bun tags releases "bun-v1.4.2" rather than "v1.4.2".
      downloadUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v$version/$archive',
      archive: 'bun-linux-$arch.zip', archiveFormat: 'zip', member: 'bun-linux-$arch/bun',
      architectures: { amd64: 'x64', arm64: 'aarch64' },
      checksums: {
        amd64: '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913',
        arm64: '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7',
      },
    }),
  },
];

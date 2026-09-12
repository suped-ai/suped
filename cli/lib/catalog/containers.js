// The Docker client, for building and running containers during local
// development. The client only: Suped does not run a daemon and does not mount
// your host's socket. Pointing this at a daemon is a decision you make
// deliberately, because mounting the host socket into a workspace gives
// anything in that workspace root on the host.
import { binaryInstall, plainBinaryInstall } from './installers.js';

const DOCKER_VERSION = '29.8.0';
const BUILDX_VERSION = '0.37.1';
const COMPOSE_VERSION = '5.5.1';

// The Docker CLI finds its subcommands here, so the plugins do not go on PATH.
const PLUGINS = '$HOME/.docker/cli-plugins';

// Each part is self-contained, with its own staging and its own trap. Running
// them in subshells keeps one part's cleanup from touching another's, and the
// outer `set -e` stops at the first failure.
const together = (...parts) => ['set -euo pipefail', ...parts.map((part) => `(\n${part}\n)`)].join('\n');

export const CONTAINER_TOOLS = [
  {
    id: 'docker', name: 'Docker', category: 'containers',
    command: 'docker', version: DOCKER_VERSION,
    description: 'Docker CLI with Compose and Buildx, for local builds and containers. Needs a daemon you provide.',
    docs: 'https://docs.docker.com/reference/cli/docker/',
    account: false,
    install: together(
      // Docker does not publish a checksum for its static binaries, unlike
      // every other entry in this catalogue. These were computed from the
      // published archives on September 12, 2026, so the pin still fixes the
      // bytes to the ones that were reviewed -- it just is not a figure the
      // vendor attests to. The archive also carries dockerd, containerd and
      // runc; only the client is extracted.
      binaryInstall({
        command: 'docker', version: DOCKER_VERSION,
        downloadUrl: 'https://download.docker.com/linux/static/stable/$arch/$archive',
        archive: 'docker-$version.tgz', member: 'docker/docker',
        architectures: { amd64: 'x86_64', arm64: 'aarch64' },
        checksums: {
          amd64: 'cc21815cf1e2efed867dc9c8b96b46ffed8ea176ffab32b0aacb54726ded8f25',
          arm64: '1462a696be6029bd478d7d60d7f3c31cdd15affd1178a4a278aaf4a1d1b7f8b5',
        },
      }),
      // Buildx is what `docker build` runs on a current client.
      // Published checksums, checked September 12, 2026:
      // https://github.com/docker/buildx/releases/download/v0.37.1/checksums.txt
      plainBinaryInstall({
        command: 'docker-buildx', version: BUILDX_VERSION, destination: PLUGINS,
        downloadUrl: `https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-$arch`,
        architectures: { amd64: 'amd64', arm64: 'arm64' },
        versionArgs: ['version'],
        checksums: {
          amd64: '9447199cdb435f25880548343c128a4b6650e8891ee598905d8d29d39a8e359b',
          arm64: 'e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2',
        },
      }),
      // Published checksums, checked September 12, 2026:
      // https://github.com/docker/compose/releases/download/v5.5.1/checksums.txt
      plainBinaryInstall({
        command: 'docker-compose', version: COMPOSE_VERSION, destination: PLUGINS,
        downloadUrl: `https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-$arch`,
        versionArgs: ['version'],
        checksums: {
          amd64: 'db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576',
          arm64: '732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7',
        },
      }),
    ),
  },
];

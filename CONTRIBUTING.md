# Contributing

Thanks for looking. This repo holds the `suped` CLI and the suped.ai homepage.
The docs site lives at https://github.com/suped-ai/suped.dev.

## Ground rule

suped ships the computer, not a harness. Changes that add agent-facing
abstractions (tool registries, orchestration, personas, memory systems, skill
packs) will be declined, however well built. Read
https://suped.dev/docs/manifesto first; it's short.

Changes that make the computer a better computer are very welcome: better
defaults, missing tools, rough edges in the CLI, clearer docs.

Human setup is part of the CLI: choosing software, installing it in the
persistent home, and signing in through the provider's own CLI. Agents then
use those ordinary tools directly. Tool selection is not an agent tool registry.
Curated MCP setup configures an existing agent client's native connections.
Suped does not proxy tool calls or run its own agent loop.

## Layout

```
cli/     the npm package. Zero dependencies. Node 18+.
  bin/   entry point
  lib/   commands, Docker lifecycle, setup, and optional tool/MCP catalogues
  docker/ the Dockerfile and the system prompt
  test/  node --test
site/    suped.ai, a single Vite page
```

## Working on the CLI

```sh
cd cli
npm test                       # unit tests, no Docker needed
node bin/suped.js --help       # run it from source
node bin/suped.js status       # talks to your local Docker
```

To test image changes without touching your real computer, point the CLI at a
throwaway image, container, and volume:

```sh
docker build -t suped-computer:dev docker
SUPED_IMAGE=suped-computer:dev SUPED_CONTAINER=suped-dev SUPED_VOLUME=suped-dev-home node bin/suped.js
```

CI runs the unit tests on Node 18, 20, and 22, builds the image, and runs the
CLI end to end against it (exact arguments/stdin, selected CLI installation,
repeat setup, reset with preserved ports/mounts, Chromium launch, and destroy).
The integration check never signs into accounts or creates remote resources.

```sh
SUPED_IMAGE=suped-computer:dev SUPED_CONTAINER=suped-verify-dev SUPED_VOLUME=suped-verify-dev-home SUPED_TEST_TOOLS=1 npm run test:integration
```

Use fresh test names: the check refuses existing containers or home volumes.
The integration check installs the full optional CLI catalogue. Set
`SUPED_TEST_TOOL_IDS=gitlab,vercel,neon` to check a smaller selection locally.
Installers in `lib/tools.js` and `lib/catalog/` pin tool versions. When adding
or updating one, verify official release checksums, both CPU architectures,
native login from a container, and an authenticated read-only status command.
Then run the integration check. MCP entries need official endpoint and client
documentation; registration must preserve existing configuration and leave
account authorization to the client.

## Working on the homepage

```sh
cd site
npm install
npm run dev
```

## Pull requests

- One change per PR. Small is good.
- Add a line to `cli/CHANGELOG.md` under Unreleased for anything user-visible.
- Don't bump the version; releases are cut separately.
- Commit messages: a short imperative summary line, then why, if it isn't obvious.

## Releasing the CLI

Maintainers only. Publishing runs in GitHub Actions with npm trusted publishing,
so there is no npm token anywhere: `.github/workflows/release.yml` proves who it
is with an OIDC token, and only a tag can trigger it.

```sh
cd cli
# move Unreleased entries in CHANGELOG.md under the new version
npm version patch|minor|major
git push --follow-tags
```

Pushing the tag is the release. The workflow runs the tests, refuses anything
that is not a `v*` tag, checks the tag matches the version in package.json, and
publishes.

One-time setup on npmjs.com, under the package's **Trusted Publisher** section
(GitHub Actions). Every field is case-sensitive and npm does not verify them
when you save, so a typo shows up as a failed publish:

| Field | Value |
|---|---|
| Organization or user | `suped-ai` |
| Repository | `suped` |
| Workflow filename | `release.yml` |
| Environment name | leave empty |

The image tag follows the package version, so users on the new CLI build a
fresh image on first run and are told to `suped reset` an older container.

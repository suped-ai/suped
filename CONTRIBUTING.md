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

## Layout

```
cli/     the npm package. Zero dependencies. Node 18+.
  bin/   entry point
  lib/   cli.js (commands) and computer.js (everything that touches Docker)
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
CLI end to end against it (up, persist across reset, Chromium launch, destroy).

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

Maintainers only.

```sh
cd cli
# move Unreleased entries in CHANGELOG.md under the new version
npm version patch|minor|major
npm publish --access public
git push --follow-tags
```

The image tag follows the package version, so users on the new CLI build a
fresh image on first run and are told to `suped reset` an older container.

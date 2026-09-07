# suped

**Lose the harness. Let it cook.**

A persistent Linux computer where any model can use real tools, run real
software, and produce real work.

```sh
npx suped@latest
```

[![ci](https://github.com/suped-ai/suped/actions/workflows/ci.yml/badge.svg)](https://github.com/suped-ai/suped/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/suped)](https://www.npmjs.com/package/suped)
[![license](https://img.shields.io/badge/license-MIT-9fb0ff)](LICENSE)

That command opens a shell in a container with a home directory that survives.
What you install, clone, configure, and log in to is still there next time,
for you or for whatever agent you hand the keys to. Nothing agent-facing sits
on top of it. No harness, no orchestrator, no persona, no memory system.

Docs and the full story: **https://suped.dev**

## The premise

AI is remarkably capable. We keep surrounding it with abstractions designed for
weaker models.

- No restrictive tool registry
- No predetermined workflows
- No skill ceremony
- No vendor-owned environment
- No guessing what the agent might need

Give it real tools and get out of the way. The abstractions go on the human
side. The agent gets a computer.

This is the entire system prompt. `suped prompt` prints it.

```
You are operating a persistent Linux computer on behalf of the user.

You have access to the shell, filesystem, installed applications, and
explicitly connected services.

Use the computer to accomplish the user's objective. Inspect the environment,
install dependencies when appropriate, write scripts, use APIs and CLIs, and
preserve useful work in the filesystem.

Ask the user only when you need information, authentication, or approval for
a consequential action.
```

## What's on the box

Ubuntu 24.04 with bash, python3, node 22, git, curl, wget, jq, sqlite3, ffmpeg,
ripgrep, unzip, build-essential, tmux, vim, uv, and Playwright with Chromium.
The `suped` user has passwordless sudo. If you need more, install it.

```
/home/suped/
  workspace/    where shells open
  projects/
  downloads/
  .config/
```

Everything under `/home/suped` is a Docker named volume and survives stops,
restarts, and CLI upgrades. See [Persistence](https://suped.dev/docs/persistence)
for exactly what survives what.

## Commands

```
suped                    open a shell (creates the computer on first run)
suped up                 start without attaching
suped exec <command...>  run a command inside
suped status
suped stop               stop it; home is kept
suped reset              recreate the container from the current image; home is kept
suped rebuild            rebuild the image, then reset
suped destroy --yes      remove the container AND the persistent home
suped prompt             print the system prompt
```

Ports and extra mounts are plain `docker run` flags, set when the container is
first created:

```sh
npx suped@latest -p 3000:3000 -v ~/data:/home/suped/data
```

Full reference: [Commands](https://suped.dev/docs/commands).

## Requirements

Docker (Desktop or Engine) and Node 18 or newer. The first run builds the image
locally from the Dockerfile in this repo, which takes a few minutes. After that
it's instant.

## This repository

| Directory | What it is |
|---|---|
| [`cli/`](cli/) | The `suped` npm package. Zero dependencies. [Changelog](cli/CHANGELOG.md). |
| [`cli/docker/`](cli/docker/) | The Dockerfile for the computer and the system prompt. |
| [`site/`](site/) | [suped.ai](https://suped.ai), the one-page homepage. |
| [`brand/`](brand/) | The logo. Used sparingly. |

The docs site is a separate repo: [suped-ai/suped.dev](https://github.com/suped-ai/suped.dev).

## Working on it

```sh
# cli: unit tests need no Docker; the CLI itself talks to your local Docker
cd cli && npm test
node bin/suped.js --help

# homepage
cd site && npm install && npm run dev
```

CI runs the CLI tests on Node 18, 20, and 22, builds the homepage, builds the
image, and drives the CLI end to end against it. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the layout, the ground rule about what
suped will and won't accept, and the release process.

## Where this goes

suped is built in two phases, in a fixed order. First, the agent's computer:
this repo, refined until an agent dropped into the box gets more done with
less friction than anywhere else. Second, the human layer on top of it: the
abstractions people need to work alongside their agent, and a workspace that
follows you to any machine. The agent never sees the second layer.

[Read the manifesto](https://suped.dev/docs/manifesto) ·
[Where this goes](https://suped.dev/docs/where-this-goes)

## License

[MIT](LICENSE)

# suped

Lose the harness. Let it cook.

```
npx suped@latest
```

That opens a shell in a persistent Linux computer where any model can use real
tools, run real software, and produce real work. Everything under `/home/suped`
survives: what you install, clone, configure, and authenticate is still there
next time, for you or for whatever agent you hand the keys to.

## The premise

AI is remarkably capable. We keep surrounding it with abstractions designed for
weaker models.

- No restrictive tool registry
- No predetermined workflows
- No skill ceremony
- No vendor-owned environment
- No guessing what the agent might need

Give it real tools and get out of the way.

```
You are operating a persistent Linux computer on behalf of the user.

You have access to the shell, filesystem, installed applications, and
explicitly connected services.

Use the computer to accomplish the user's objective. Inspect the environment,
install dependencies when appropriate, write scripts, use APIs and CLIs, and
preserve useful work in the filesystem.

Ask the user only when you need information, authentication, or approval for a
consequential action.
```

That is the whole system prompt. `suped prompt` prints it.

## What's on the box

Ubuntu 24.04 with bash, python3, node 22, git, curl, wget, jq, sqlite3, ffmpeg,
ripgrep, unzip, build-essential, tmux, vim, uv, and Playwright with Chromium.
The user has passwordless sudo. If you need more, install it.

What persists: everything under `/home/suped`, always. That covers clones,
venvs, `npm i -g` with a user prefix, uv tools, dotfiles, credentials, and
whatever you keep in `workspace/`. System packages from `apt` live in the
container itself, so they survive `stop`, `start`, and Docker restarts, but
not `reset` or `rebuild`. Prefer installing into your home when you can.

```
/home/suped/
  workspace/    where shells open
  projects/
  downloads/
  .config/
```

No special filesystem layout, no suped-specific abstractions. Linux is Linux.

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

Ports and extra mounts are set when the container is first created:

```
npx suped@latest -p 3000:3000 -v ~/data:/home/suped/data
```

Change them later with `suped reset -p ...`.

## Requirements

Docker (Desktop or Engine) and Node 18 or newer. The first run builds the image
locally, which takes a few minutes. After that it's instant.

## Links

- https://suped.dev
- https://github.com/suped-ai/suped

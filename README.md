# suped

**A suped-up workspace for agents.**

Choose the tools you work with. Connect your accounts. Hand your agent a
Linux workspace where those tools are installed, signed in, and ready to use.

```sh
npx suped@latest
```

[![ci](https://github.com/suped-ai/suped/actions/workflows/ci.yml/badge.svg)](https://github.com/suped-ai/suped/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/suped)](https://www.npmjs.com/package/suped)
[![license](https://img.shields.io/badge/license-MIT-9fb0ff)](LICENSE)

Version 0.2.0 includes guided setup, 17 optional CLIs, and nine official MCP
connections. The examples below use a global installation (`npm i -g suped`);
you can use `npx suped@latest` in place of `suped` without installing globally.

## Set up your workspace

You need Docker Desktop or Engine running Linux containers, and Node 18+ on
your computer. The first run builds the base image locally and takes a few
minutes. Later runs reuse it.

On your first interactive run, choose websites and apps, data and services,
individual tools, or the base workspace. Guided choices let you pick providers
in each category. Suped installs only your selections into the persistent home
and helps you connect them. You can connect an account later.

| Category | Choices | What your agent can use them for |
|---|---|---|
| Repositories | GitHub, GitLab | Repos, issues, reviews, and Git authentication |
| Hosting | Cloudflare, Vercel, Netlify, Railway, Fly.io, Render | Apps, previews, deployments, and logs |
| Databases | Supabase, Neon, Turso, PlanetScale | Projects, databases, branches, and migrations |
| Cloud | Firebase, DigitalOcean | App services and infrastructure |
| Payments | Stripe | Payment integration and webhook development |
| Agents | Codex, Claude Code | Run your chosen agent beside the tools |

```sh
suped setup                         # choose tools and connect accounts
suped catalog                       # browse choices without starting Docker
suped setup gitlab vercel neon       # choose an alternative app stack
suped setup stripe codex --skip-auth # install now, connect later
suped login neon
suped tools gitlab vercel neon       # check this stack's account access
```

Suped uses the provider CLIs for login. Credentials stay in their normal
locations under `/home/suped`; Suped stores only your tool selections. Logins
can expire or be revoked. `suped login <tool>` reconnects them. Neon uses a
hidden API-key prompt piped to its native CLI. Turso prints a manual connection
step; it is not connected until that step is complete and verified.

Official MCP connections add services such as Notion, Linear, Figma, and Sentry
to the agent client you choose. Registration and account authorization are
separate; existing client configuration is preserved.

```sh
suped mcp list
suped setup claude --skip-auth
suped mcp add notion linear --client claude
suped exec claude mcp login notion --no-browser
```

See [the tool catalogue](https://suped.dev/docs/tools) and
[MCP setup](https://suped.dev/docs/mcp) for all choices and headless login steps.

Supabase's hosted commands are available here. Its local database stack needs
a Docker daemon inside or reachable from the workspace; Suped does not mount
your host's Docker socket or set up that local stack.

## Upgrade an existing workspace

Run `npx suped@latest reset` to build the current image and recreate your
container, then `npx suped@latest setup` to choose tools. Use the same
`SUPED_CONTAINER` and `SUPED_VOLUME` settings if you customized them. Your
home, selected tools, saved logins, ports, and mounts are retained. Processes
stop during recreation, and system packages installed with apt after the
image was built need to be reinstalled. Opening an older workspace first
keeps it running and prints a reminder to reset.

## Give the agent work

Select Codex or Claude Code during setup, install another agent CLI, or connect an external
agent's shell execution to `suped exec`. Suped supplies the workspace; bring
the agent you want to use.

Once GitHub and Cloudflare are connected, an objective can be:

> Build a blog for my photography projects. Create a GitHub repository,
> commit and push the source, create a Cloudflare Pages project, and deploy
> the site. Save the source here and give me the repository and live URLs.

The agent uses `git`, `gh`, `wrangler`, and ordinary files. What it can access
depends on the accounts and permissions you connected.

```sh
suped exec gh auth status
suped exec wrangler whoami
suped exec 'cd ~/projects/my-blog && git status'
```

`suped prompt` prints a short operating brief, also available inside the box
at `/etc/suped/prompt.md`. Add your objective. There is no required persona,
workflow format, or agent framework.

## What's on the box

Ubuntu 24.04 with bash, Python, Node, git, curl, wget, jq, sqlite3, ffmpeg,
ripgrep, unzip, build-essential, tmux, editors, uv, and Playwright/Chromium.
The `suped` user has passwordless sudo. Add whatever else your work needs.

```text
/home/suped/
  workspace/    where shells and exec commands start
  projects/
  downloads/
  .local/       selected CLIs and user-installed tools
  .config/      tool settings and workspace setup
```

The home is a Docker named volume. Files, selected CLIs, and saved logins
survive stops, restarts, reset, and rebuild. Additional system packages
installed with `apt` survive stops but are lost on reset/rebuild. Shared
files let another agent pick up saved work; save any context it will need.

## Move a workspace to another machine

A workspace is defined by the tools you selected, the ports and mounts it was
created with, and the repositories in it. `sync` writes exactly that to a small
JSON file you can commit anywhere.

```sh
suped sync                      # what defines this workspace, and what would not move
suped sync save workspace.json  # write it; "-" prints to stdout
suped sync restore workspace.json   # on the other machine
```

`suped sync` is worth running before you travel: it names every repository with
uncommitted changes, commits that are not on a remote, or no remote at all —
the work a move would leave behind.

The file contains no credentials, so connect accounts on the new machine with
`suped login <tool>`. The home volume is not copied: `restore` reinstalls the
selected tools, so they are built for the architecture they land on, and clones
each project from its remote. Existing directories are never overwritten. Ports
and mounts are applied when a container is created, so `restore` prints the
`suped reset` command to apply them.

To copy a home volume byte for byte instead, including its saved logins, see the
backup instructions at [suped.dev/docs/persistence](https://suped.dev/docs/persistence).

## Commands

```text
suped                    set up if needed, then open a shell
suped up                 set up if needed, then leave the workspace running
suped catalog            browse available CLIs by category
suped setup [tools...]   install tools and connect accounts
suped tools [tools...]   check tools and connections
suped login <tools...>   connect or reconnect accounts
suped mcp list           browse official remote MCP connections
suped mcp add <ids...> --client codex|claude   register connections in a client
suped mcp export <ids...> --client codex|claude|cursor   print config to merge
suped exec <command...>  run an exact program/arguments, or one quoted shell command
suped sync               show what defines this workspace, and what would not move
suped sync save <file>   write the workspace to a portable file (no credentials)
suped sync restore <file>  install that workspace's tools and clone its projects
suped status             show Docker/container/image/volume state
suped stop               stop the computer; keep its files
suped reset              recreate the container; keep home, ports, and mounts
suped rebuild            rebuild the base image, then reset
suped destroy --yes      remove the container AND its home volume
suped prompt             print the operating brief
```

First-run setup appears only in an interactive terminal. `exec` never launches
setup. For unattended installation, specify tools and `--skip-auth`.

Ports and extra mounts are configured at creation:

```sh
suped -p 3000:3000 -v ~/data:/home/suped/data
suped reset -p 8080:8080
```

Reset/rebuild retain the existing ports and mounts. Supplying `-p` replaces
the port list; `-v` replaces the extra-mount list. For `exec`, put Suped's
options before the command: `suped -p 3000:3000 exec node --version`.

## This repository

| Directory | What it is |
|---|---|
| `cli/` | The zero-dependency `suped` npm package |
| `cli/docker/` | Base image and operating brief |
| `site/` | The single-command install page at [suped.ai](https://suped.ai) |
| `brand/` | Brand assets |

The docs and product site live separately at [suped.dev](https://suped.dev),
in [suped-ai/suped.dev](https://github.com/suped-ai/suped.dev).

```sh
cd cli
npm test
node bin/suped.js --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release instructions.

## Where this goes

First, make the CLI a dependable way to prepare a workspace for your agent:
choose software, connect accounts, and get to work. Later, a graphical setup
will guide people through those same choices, including account creation and
authentication. The agent continues to use the same ordinary computer.

## License

[MIT](LICENSE)

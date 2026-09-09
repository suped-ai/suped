# suped

**A suped-up workspace for agents.**

Choose your tools, connect your accounts, and give your agent a Linux workspace
that is ready to work. Files, selected tools, and saved logins stay in its
persistent home between sessions.

```sh
npx suped@latest
```

Version 0.2.0 includes guided setup, 17 optional CLIs, and nine official MCP
connections.

## Requirements

Docker Desktop or Engine running Linux containers, and Node 18+. The first run
builds the base image locally and takes a few minutes. Later runs reuse it.

## Tools and accounts

The first interactive run guides you through provider choices. Select GitHub
or GitLab; Cloudflare, Vercel, Netlify, Railway, Fly.io, or Render; Supabase,
Neon, Turso, or PlanetScale. Add Firebase, DigitalOcean, Stripe, Codex, or
Claude Code when your work needs them. Only selected CLIs are installed.

The commands below use a global installation (`npm i -g suped`); use
`npx suped@latest` in its place if you prefer.

```sh
suped setup
suped catalog
suped setup gitlab vercel neon
suped setup stripe codex --skip-auth
suped login neon
suped tools gitlab vercel neon
```

Selected CLIs install under `~/.local`. Providers store credentials in their
normal home locations; Suped saves selections, not credentials. A revoked
or expired login can be renewed with `suped login <tool>`.

Neon uses a hidden API-key prompt piped to the native CLI. Turso requires a
manual completion step, printed by `suped login turso`. The other choices use
their provider or agent client's native login. Account setup may require your
own browser, existing account, or subscription.

## App connections through MCP

Register official remote servers for Notion, Linear, Atlassian, Figma, Sentry,
Stripe, Neon, Supabase, and Vercel. Existing client settings are preserved.

```sh
suped mcp list
suped setup claude --skip-auth
suped mcp add notion linear --client claude
suped exec claude mcp login notion --no-browser
suped mcp export notion figma --client cursor
```

Registration does not authorize an account. Follow the printed client login
steps. [MCP documentation](https://suped.dev/docs/mcp) covers headless browser
callbacks, Codex registration, and exported client configuration.

Setup installs the versions supported by this Suped release. Running setup
again restores those versions for the selected tools, including after a manual
upgrade. It does not uninstall other tools or erase account configuration.

Supabase's hosted project commands are available. Its local stack requires a
separate Docker daemon connection, which Suped does not configure.

## Give your agent work

Select Codex or Claude Code in setup, install another agent CLI, or connect an
external agent's shell execution to `suped exec`.

With GitHub and Cloudflare connected, ask it to build your app, create a
repository, and deploy a Cloudflare Pages project. It uses the real CLIs with
the access you granted. Suped supplies the prepared workspace; you bring the agent.

```sh
suped exec gh auth status
suped exec wrangler whoami
suped exec 'cd ~/projects/my-app && git status'
```

`suped prompt` prints the short operating brief at `/etc/suped/prompt.md`.

## Commands

```text
suped                    set up if needed, then open a shell
suped up                 start without attaching; offer setup in a terminal
suped catalog            browse optional CLIs without starting Docker
suped setup [tools...]   choose tools and authenticate (or --skip-auth)
suped tools [tools...]   show tools and connection status
suped login <tools...>   connect accounts
suped mcp list           browse official remote MCP servers
suped mcp add <ids...> --client codex|claude   register servers in a client
suped mcp export <ids...> --client codex|claude|cursor   print config to merge
suped exec <command...>  run exact arguments, or one quoted shell command
suped status
suped stop               keep the container and home
suped reset              recreate container; keep home, ports, and mounts
suped rebuild            rebuild image, then reset
suped destroy --yes      remove container AND persistent home
suped prompt
```

Noninteractive `up` and all `exec` calls skip the wizard. Unattended setup
requires named tools and `--skip-auth`.

```sh
suped -p 3000:3000 -v ~/data:/home/suped/data
suped reset -p 8080:8080
```

Reset/rebuild preserve ports and mounts unless that category is replaced with
`-p` or `-v`. Put Suped options before `exec`; subsequent flags belong to the
program being run.

## Persistence

Ubuntu includes Python, Node, git, common command-line utilities, uv, and
Playwright/Chromium. The user has passwordless sudo. Shells start in
`/home/suped/workspace`; `~/projects` and `~/downloads` are also available.

Everything under `/home/suped` survives reset/rebuild, including selected CLIs
and saved provider logins. Extra system packages installed with `apt` survive
stops and starts, but are lost on reset/rebuild. `destroy --yes` deletes the
home volume. Shared files preserve work; write down any context another agent
will need to continue it.

## Upgrade from an earlier version

Run `npx suped@latest reset`, then `npx suped@latest setup`. Keep the same
`SUPED_CONTAINER` and `SUPED_VOLUME` settings if you customized them. Reset
builds the current image before replacing the old container. Home, saved
logins, selected tools, ports, and mounts remain; running processes stop and
extra apt packages need to be reinstalled. Opening an existing workspace
without resetting keeps its current image and displays a reminder.

## Links

- [Documentation](https://suped.dev)
- [Source and issues](https://github.com/suped-ai/suped)

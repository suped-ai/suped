# Changelog

All notable changes to the `suped` package. The image tag follows the package
version, so an image change is a package change.

## Unreleased

- Add `sync`, which moves a workspace between machines. `suped sync` shows what defines this workspace and names the work that would be left behind; `suped sync save <file>` writes that to a portable JSON file; `suped sync restore <file>` installs the file's tools and clones its projects on another machine. The file records the tool selection, published ports, extra mounts, and each project's remote and branch. It never contains saved logins, and the home volume is not copied, so tools are reinstalled for the architecture they land on.

## 0.2.0 · 2026-09-09

- Guided workspace setup with 17 optional CLIs across repositories, hosting, databases, cloud, payments, and agents. Choose providers in each category; selected tools and provider logins live in the persistent home.
- Add `catalog`, `setup`, `tools`, and `login` commands. Interactive first runs offer setup; unattended runs never prompt for authentication. Filter connection checks with `tools <ids...>`.
- Add nine official remote MCP connections, registration for Codex and Claude Code, and config export for Codex, Claude Code, and Cursor. Existing settings are preserved; authorization stays explicit in the selected client.
- Preserve command flags, argument boundaries, and piped input in `exec`.
- Preserve ports and extra mounts across reset/rebuild, and prepare the replacement image before removing the container.
- Put home-installed tools on PATH for direct commands and agent processes.
- Reframe the docs around choosing tools, connecting accounts, and handing an agent a working environment.
- Pin Playwright to 1.63.0 in the image so the global package and the bundled Chromium always match.

## 0.1.0 · 2026-09-07

First release.

- `suped` opens a shell in a persistent Linux computer, creating it on first run.
- `up`, `exec`, `status`, `stop`, `reset`, `rebuild`, `destroy --yes`, `prompt`.
- `-p/--publish` and `-v/--volume` pass through to `docker run` at creation.
- `SUPED_CONTAINER`, `SUPED_VOLUME`, `SUPED_IMAGE` for running several computers or a custom image.
- Image: Ubuntu 24.04 with bash, python3, node 22, git, curl, wget, jq, sqlite3, ffmpeg, ripgrep, unzip, build-essential, tmux, vim, uv, and Playwright with Chromium. User `suped` with passwordless sudo. Home skeleton: workspace, projects, downloads, .config.
- The system prompt is at `/etc/suped/prompt.md` inside the image.

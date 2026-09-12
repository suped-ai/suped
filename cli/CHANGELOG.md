# Changelog

All notable changes to the `suped` package. The image tag follows the package
version, so an image change is a package change.

## Unreleased

- The secret store holds records, not strings. An account is an address, a password, a second factor, recovery codes and whatever key was issued later; storing one string threw all of that away. Entries now have a kind: `token` for a credential a tool can be signed back in with, `email` for a mailbox you already own, and `account` for an account at a service. `suped secrets list`, `show <id>` (secrets hidden unless `--reveal`), `set <id>` (one entry as JSON on stdin) and `remove <id>` work on a store kept in the workspace at `~/.config/suped/secrets.age`. Files written by the previous version still open, read as tokens.
- An account a person had to create by hand has somewhere to live. Where a service will not allow an agent to sign up, the agent records the account as `pending` with what it still needs; `suped secrets` and `list` surface those, and finishing the signup is just replacing the entry. Accounts are signed up with a mailbox you already configured, not one invented per service.

- Run a scheduler. `cron` is in the base image and the computer now starts it, so `crontab -e` schedules work that actually runs. Previously cron was not installed and the container ran `sleep infinity`, so nothing would have run it. The user's crontab starts with a `PATH` that includes `~/.local/bin`, because cron gives jobs `PATH=/usr/bin:/bin` and ignores both the container environment and `/etc/environment`; wrap commands in `bash -lc` if you replace the whole crontab. A computer created before this keeps running `sleep infinity` until you `suped reset`.

- Add `secrets`, which hands account access to another machine without a hosted service. `suped secrets` shows which credentials can travel and which have to be re-authenticated; `suped secrets key` creates the workspace's encryption identity; `suped secrets save <file>` seals the credentials that can travel; `suped secrets restore <file>` signs those tools back in. The sealed file is age-encrypted and safe to commit; the identity is the one thing you move between machines yourself. `sync` still carries no credentials, so exporting them is never a side effect of something else. GitHub is the first provider; each one is added only once its token round-trip is verified against a real login.
- Add `age` to the base image, for `secrets`.

- Make the heavy software optional. The base image no longer carries Playwright/Chromium, ffmpeg, or a C toolchain: it builds in about a minute instead of three and is roughly a quarter of the size. Choose extras with `--with browser,build,media` when the computer is created, or change them later with `suped rebuild --with ...` (`--without` bakes none of them in). `suped status` reports what is baked in.
- Bake optional software into the image rather than installing it into the container. System packages do not survive `reset`, so a browser installed at setup time would disappear on the next upgrade. The selection is part of the image tag, and `reset`/`rebuild` keep it unless `--with`/`--without` says otherwise.
- Use Playwright's `chromium-headless-shell` instead of full Chromium for `--with browser`. Same Playwright API for automation and JS-heavy pages, about 600 MB smaller.
- Add `w3m` and `lynx` to the base, so reading documentation and articles as text needs no browser engine.
- Carry software the workspace grew. `sync` now also records what was installed after setup — apt packages beyond the image's own, `uv` tools, and npm globals under the home prefix — by inspecting the workspace rather than asking anyone to record it, and `sync restore` reinstalls them. apt packages still do not survive `reset`, and `sync` now says so and points at `uv` or a home npm prefix for anything you keep.
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

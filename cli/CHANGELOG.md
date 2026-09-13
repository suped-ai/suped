# Changelog

All notable changes to the `suped` package. The image tag follows the package
version, so an image change is a package change.

## Unreleased

Found by running a real project inside a workspace as the agent would.

- Add **Node.js** to the Languages catalogue (26.8.2). The image keeps Node 22, because setup installs agent clients and provider CLIs with npm and that has to exist before any selection runs — but a project could not choose a newer one, and one that runs `.ts` files directly needs native type stripping. `suped setup node` puts a current Node ahead of the image's on PATH.
- `npm i -g` works, and lands in the home. npm's global prefix was `/usr`, so the obvious way to install pnpm or any npm tool failed with EACCES, and a `sudo` install would not have survived `reset`. The image now sets `NPM_CONFIG_PREFIX` to `~/.local`.
- Say which Docker problem it is. "Docker is not available; install Docker" covered three situations, and the one people hit — Docker installed and running, but this user not allowed to use its socket because the `docker` group was granted after login — told them to install Docker. The message now names the actual problem and the fix for each.

## 0.6.0 · 2026-09-13

Several machines, one workspace. 0.4.0 could install and sign in; this release
moves the whole thing — and, for the first time, the work you were in the
middle of. Uncommitted changes and commits that were on no remote now travel
with everything else instead of being listed as "at risk" and left behind.

There is no 0.5.0. It was planned as the portability release and all of its
work is here, alongside the shared-state work that followed it.

- Add `state`, which keeps several machines in step instead of carrying a workspace by hand. `suped state init <git-url>` puts the workspace's definition in a repository; `suped state sync` installs any tool and clones any project the shared state has and this machine does not, records what this machine is, and pushes; `suped state` shows what differs without changing anything. `git log` on that repository is the workspace's history. Most of the time there is nothing to resolve: two machines that each added a tool have not conflicted, and nearly everything that defines a workspace is a set. Ports and mounts are deliberately not shared — a mount names a host path the other machine does not have, and a published port describes where a workspace runs rather than what it is. The repository lives inside the workspace and pushes with the connection it already has, and contains no credentials.
- Add `move`, which is the whole job in one command each side. `suped move save <dir>` writes what the workspace *is* and what it can *sign into* together; `suped move restore <dir>` rebuilds it and signs its tools back in, in that order, because a tool has to exist before its credential can be handed back to it. `suped move` alone shows everything that would travel. Your identity file is deliberately not in that directory — everything written there is safe to commit, and the identity is the one thing that is not. `sync` and `secrets` are unchanged and still usable on their own; `sync save` in particular can never include a credential, which is what makes it the right thing to hand to someone else.
- `move` carries **work in progress**. Until now `sync` found uncommitted changes and commits that were on no remote, called them "at risk", and left them behind — which is the half of a move you actually feel. Each project's work is now pushed to a ref under `refs/suped/` on that project's own remote, so it travels without touching your branches or your history, and it is recoverable with plain git. Capturing does not disturb the repository it captures: the commit is built through a temporary index and pushed by object id, so HEAD, the index and the working tree are untouched — no stash, no checkout. On the other machine it comes back as what it was, including deletions and files that were never added. `--no-work` opts out, and `suped sync save` still carries nothing, because describing a workspace must stay a read of it. A project with no remote has nowhere to put its work and says so. Work also lands in a project the far machine already has, provided that checkout has nothing of its own to lose — clean, on the same branch, and not ahead on a history of its own; otherwise it is refused with the reason and the ref the work is still on. This is a handoff rather than two-way replication: the machine you left keeps its copy, and suped never deletes uncommitted work.
- The identity moves in one step: `suped secrets key --show | ssh other-machine suped secrets key --import`. It is the one secret the design deliberately does not carry for you, and until now moving it meant finding a file path by hand. `--show` prints the key and nothing else to stdout so it pipes cleanly, with the explanation on stderr. `--import` verifies the key on a staged copy before activating it — the same verify-before-activate rule the tool installers follow, because a key that has replaced a working one loses every secret sealed to it — and refuses to replace an existing identity unless `--replace` says so.
- The home has `notes/` and `scratch/`, and the layout now says what a move carries. `suped sync` carries the git repositories under `workspace/`, `projects/` and `notes/` by remote and branch, so a notes directory that is a git repository travels on exactly the same terms as a project, with no separate mechanism; `scratch/` and `downloads/` are the places that stay on one machine.
- Missing home directories are created when the workspace starts. Docker seeds the image's home skeleton into a named volume only on that volume's **first** mount, so until now a directory added to the image could never appear in a workspace that already existed — which is how uv came to be missing from every workspace created before it was added. `suped up` now repairs the skeleton of a running workspace too. It only ever creates what is absent, and `suped exec` deliberately does not pay for the check.

## 0.4.0 · 2026-09-12

The workspace can do local work now. Until this release it could talk to every
cloud provider you selected but could not run a Python script, build a Go
binary, or check a container image. Languages and the Docker client close that
gap, and none of them have an account to connect.

- Add a **Languages** category: Python 3.14.7 (with `uv` and `uvx`), Go 1.27.1, Deno 2.9.6, and Bun 1.4.2. Node.js was already in the base image; these are the other runtimes an agent needs to run code, build, and test locally. Each is pinned and checksum-verified and unpacks into the persistent home rather than the image, so adding one later does not mean rebuilding. `suped setup python go`, or choose them during guided setup.
- Add a **Containers** category with **Docker**: the client only — the CLI plus the Compose and Buildx plugins, which install to `~/.docker/cli-plugins` rather than PATH. Suped runs no daemon and never mounts your host's socket; point the client at one with `DOCKER_HOST`, or mount the host socket yourself with `-v` knowing that it grants anything in the workspace root on the host. Docker publishes no checksum for its static binaries, so those two figures were computed from the published archives rather than attested by the vendor; everything else in the catalogue uses the publisher's own.
- Add **Herdr** to the catalogue, under a new Workspace category: a terminal workspace manager for running several agents side by side and reattaching later. `suped setup herdr`, or choose it during guided setup.
- Tools can be install-only. Setup no longer offers to connect an account for something that has none, `suped tools` reports it as installed rather than "connection not verified", and `suped login` says why it cannot be connected instead of failing a login that could never exist.
- uv is pinned and checksum-verified, and comes with the Python selection rather than the base image. It was installed from `astral.sh/uv/install.sh` at image build time — the one unpinned download in the project — and it was written into the home skeleton, which Docker only copies into a volume on its first mount, so no existing workspace ever received it. Ubuntu's `python3` is still in the base; selecting Python puts a current CPython and `uv` ahead of it on PATH.
- `suped secrets env` prints shell exports for the credentials providers read from the environment. Most of the catalogue works that way — it is how each is documented to run in CI — so for those a stored token replaces signing in rather than supplementing it, and one token covers every machine: `eval "$(suped secrets env)"`. Thirteen tools carry their documented variable; an entry's own `env` map always wins, and can pull a value out of an account record (`{"RESEND_API_KEY": "keys.api"}`). Only the export lines go to stdout, so the output is safe to eval.

## 0.3.0 · 2026-09-12

Published straight after 0.1.0: 0.2.0 was tagged but never reached npm, so this is
the first release to carry the guided setup. Everything 0.2.0 described is here.

- Make the heavy software optional. The base image no longer carries Playwright/Chromium, ffmpeg, or a C toolchain: it builds in about a minute instead of three and is roughly a quarter of the size. Choose extras with `--with browser,build,media` when the computer is created, or change them later with `suped rebuild --with ...` (`--without` bakes none of them in). `suped status` reports what is baked in.
- Bake optional software into the image rather than installing it into the container. System packages do not survive `reset`, so a browser installed at setup time would disappear on the next upgrade. The selection is part of the image tag, and `reset`/`rebuild` keep it unless `--with`/`--without` says otherwise.
- Use Playwright's `chromium-headless-shell` instead of full Chromium for `--with browser`. Same Playwright API for automation and JS-heavy pages, about 600 MB smaller.
- Add `w3m` and `lynx` to the base, so reading documentation and articles as text needs no browser engine.
- Add `sync`, which moves a workspace between machines. `suped sync` shows what defines this workspace and names the work that would be left behind; `suped sync save <file>` writes that to a portable JSON file; `suped sync restore <file>` installs the file's tools and clones its projects on another machine. The file records the tool selection, published ports, extra mounts, and each project's remote and branch. It never contains saved logins, and the home volume is not copied, so tools are reinstalled for the architecture they land on.
- Carry software the workspace grew. `sync` also records what was installed after setup — apt packages beyond the image's own, `uv` tools, and npm globals under the home prefix — by inspecting the workspace rather than asking anyone to record it, and `sync restore` reinstalls them. apt packages still do not survive `reset`, and `sync` says so and points at `uv` or a home npm prefix for anything you keep.
- Add `secrets`, which hands account access to another machine without a hosted service. `suped secrets` shows which credentials can travel and which have to be re-authenticated; `suped secrets key` creates the workspace's encryption identity; `suped secrets save <file>` seals what can travel; `suped secrets restore <file>` signs those tools back in. The sealed file is age-encrypted and safe to commit; the identity at `~/.config/suped/credy.key` is the one thing you move between machines yourself. `sync` still carries no credentials, so exporting them is never a side effect of something else. GitHub is the first provider; each is added only once its token round-trip is verified against a real login.
- The secret store holds records, not strings. An account is an address, a password, a second factor, recovery codes and whatever key was issued later. Entries have a kind: `token` for a credential a tool can be signed back in with, `email` for a mailbox you already own, and `account` for an account at a service. `suped secrets list`, `show <id>` (secrets hidden unless `--reveal`), `set <id>` (one entry as JSON on stdin) and `remove <id>` work on a store kept at `~/.config/suped/secrets.age`.
- An account a person had to create by hand has somewhere to live. Where a service will not allow an agent to sign up, the agent records the account as `pending` with what it still needs; `suped secrets` and `list` surface those, and finishing the signup is just replacing the entry. Accounts are signed up with a mailbox you already configured, not one invented per service.
- Run a scheduler. `cron` is in the base image and the computer now starts it, so `crontab -e` schedules work that actually runs. The user's crontab starts with a `PATH` that includes `~/.local/bin`, because cron gives jobs `PATH=/usr/bin:/bin` and ignores both the container environment and `/etc/environment`; wrap commands in `bash -lc` if you replace the whole crontab. `reset` carries the crontab across, since it lives in the container rather than the home. A computer created before this keeps running `sleep infinity` until you `suped reset`.
- Add `age` to the base image, for `secrets`.
- Publish from a tag with npm trusted publishing rather than a token, so no long-lived npm credential exists anywhere.

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

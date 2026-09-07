# Changelog

All notable changes to the `suped` package. The image tag follows the package
version, so an image change is a package change.

## Unreleased

- Tagline is now "Lose the harness. Let it cook." in the package description, README, and help banner.
- Pin Playwright to 1.63.0 in the image so the global package and the bundled Chromium always match.

## 0.1.0 · 2026-09-07

First release.

- `suped` opens a shell in a persistent Linux computer, creating it on first run.
- `up`, `exec`, `status`, `stop`, `reset`, `rebuild`, `destroy --yes`, `prompt`.
- `-p/--publish` and `-v/--volume` pass through to `docker run` at creation.
- `SUPED_CONTAINER`, `SUPED_VOLUME`, `SUPED_IMAGE` for running several computers or a custom image.
- Image: Ubuntu 24.04 with bash, python3, node 22, git, curl, wget, jq, sqlite3, ffmpeg, ripgrep, unzip, build-essential, tmux, vim, uv, and Playwright with Chromium. User `suped` with passwordless sudo. Home skeleton: workspace, projects, downloads, .config.
- The system prompt is at `/etc/suped/prompt.md` inside the image.

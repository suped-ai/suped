# suped computer — a plain Linux box with a persistent home.
# Nothing here is special. If you need more, install it from inside.
#
# The base stays small so a first run is quick. Everything heavy is opt-in and
# baked into the image, not installed into the container at setup time: system
# packages do not survive `suped reset`, so a browser installed that way would
# disappear on the next upgrade. Choosing a feature changes the image tag, and
# reset recreates the container from that same tag.

FROM ubuntu:24.04

ARG WITH_BROWSER=0
ARG WITH_MEDIA=0
ARG WITH_BUILD=0

LABEL org.opencontainers.image.title="suped computer" \
      org.opencontainers.image.url="https://suped.dev" \
      org.opencontainers.image.source="https://github.com/suped-ai/suped"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Base tools. w3m and lynx render a page to text for about 7 MB, which covers
# reading docs and articles without a browser engine.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg \
      bash git jq sqlite3 ripgrep unzip zip \
      w3m lynx \
      python3 python3-pip python3-venv \
      sudo tmux less vim nano openssh-client procps \
      tzdata locales \
    && rm -rf /var/lib/apt/lists/*

# Node.js (current LTS line). Not optional: setup installs the agent clients and
# several provider CLIs with npm, so it has to exist before any selection runs.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# A C toolchain, for packages that compile native extensions on install.
RUN if [ "$WITH_BUILD" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ffmpeg and its codecs.
RUN if [ "$WITH_MEDIA" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Playwright driving Chromium. chromium-headless-shell is the headless-only
# build: same Playwright API, roughly 600 MB smaller than full chromium. Most of
# what remains is Chromium's own system libraries, which --with-deps installs.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      npm install -g playwright@1.63.0 \
      && playwright install --with-deps chromium-headless-shell \
      && chmod -R a+rX /opt/playwright \
      && rm -rf /var/lib/apt/lists/* /root/.npm; \
    fi

# Record what was baked in, so the CLI can report it from the image alone.
LABEL dev.suped.features=""

# The system prompt lives on the box too, for anything that wants it
COPY prompt.md /etc/suped/prompt.md

# The user. Replace Ubuntu's default uid-1000 user with ours.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash suped \
    && echo "suped ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/suped \
    && chmod 0440 /etc/sudoers.d/suped

USER suped
WORKDIR /home/suped

# Tools selected during setup install in the persistent home. Keep them on
# PATH for shells, direct Docker exec, and agent processes alike.
ENV PATH="/home/suped/.local/bin:${PATH}"

# Home skeleton. Docker copies this into the named volume on first mount,
# so it persists and grows with whatever you do afterwards.
RUN mkdir -p workspace projects downloads .config .local/bin \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> .bashrc

WORKDIR /home/suped/workspace
CMD ["sleep", "infinity"]

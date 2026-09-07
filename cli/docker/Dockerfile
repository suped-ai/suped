# suped computer — a plain Linux box with a persistent home.
# Nothing here is special. If you need more, install it from inside.

FROM ubuntu:24.04

LABEL org.opencontainers.image.title="suped computer" \
      org.opencontainers.image.url="https://suped.dev" \
      org.opencontainers.image.source="https://github.com/suped-ai/suped"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Base tools
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg \
      bash git jq sqlite3 ffmpeg ripgrep unzip zip \
      python3 python3-pip python3-venv \
      build-essential pkg-config \
      sudo tmux less vim nano openssh-client procps \
      tzdata locales \
    && rm -rf /var/lib/apt/lists/*

# Node.js (current LTS line)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Playwright + Chromium, installed system-wide so any project can use them
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install -g playwright \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# The system prompt lives on the box too, for anything that wants it
COPY prompt.md /etc/suped/prompt.md

# The user. Replace Ubuntu's default uid-1000 user with ours.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash suped \
    && echo "suped ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/suped \
    && chmod 0440 /etc/sudoers.d/suped

USER suped
WORKDIR /home/suped

# Home skeleton. Docker copies this into the named volume on first mount,
# so it persists and grows with whatever you do afterwards.
RUN mkdir -p workspace projects downloads .config .local/bin \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> .bashrc

WORKDIR /home/suped/workspace
CMD ["sleep", "infinity"]

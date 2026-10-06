FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Electron's runtime libraries plus Xvfb, and git so the server has a repository to serve.
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates dbus-x11 file git jq less procps util-linux xauth xvfb zlib1g \
    libasound2t64 libatk-bridge2.0-0 libatspi2.0-0 libcairo2 libcups2t64 libdrm2 libgbm1 \
    libgtk-3-0 libnss3 libpango-1.0-0 libx11-xcb1 libxcb-dri3-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 \
  && rm -rf /var/lib/apt/lists/*

# Why: packaged `orca serve` is meant to run as an unprivileged account.
RUN useradd --create-home --shell /bin/bash orca
USER orca
WORKDIR /home/orca

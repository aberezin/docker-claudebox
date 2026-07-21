FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

# NOTE ON LAYER CACHING: the volatile bits — the fork version stamp and the harness
# scripts/CHANGELOG — deliberately do NOT live in `base`. Because `full` is `FROM base`,
# anything that changes here would bust full's entire (expensive) Go/npm/pyenv toolchain
# on every release or script edit. Instead they're assembled in the cheap `harness` stage
# below and COPY --from'd in at the very END of each variant, after the toolchain. Keep
# `base` limited to slow-changing, cacheable installs.

# faster apt mirror — Cloudflare
RUN sed -i 's|http://archive.ubuntu.com|http://cloudflaremirrors.com|g; s|http://security.ubuntu.com|http://cloudflaremirrors.com|g' /etc/apt/sources.list.d/ubuntu.sources || true

# core essentials
RUN apt-get update && apt-get install -y \
    git curl wget gnupg ca-certificates sudo \
    software-properties-common lsb-release jq \
    && rm -rf /var/lib/apt/lists/*

# node.js (needed for claude CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# python3 + api server deps (needed for CLAUDE_MODE_API)
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages --ignore-installed fastapi uvicorn python-telegram-bot pyyaml mcp croniter

# docker (needed for docker-in-docker)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# create 'claude' user with sudo and docker access (remove ubuntu user that ships at uid 1000)
RUN userdel -r ubuntu 2>/dev/null || true && \
    useradd -u 1000 -ms /bin/bash claude && \
    usermod -aG sudo claude && \
    usermod -aG docker claude && \
    mkdir -p /home/claude/.ssh && \
    ssh-keyscan github.com gitlab.com bitbucket.org >> /home/claude/.ssh/known_hosts 2>/dev/null && \
    chown -R claude:claude /home/claude

# passwordless sudo
COPY <<EOF /etc/sudoers.d/claude-nopass
claude ALL=(ALL) NOPASSWD:ALL
EOF
RUN chmod 440 /etc/sudoers.d/claude-nopass

# claude CLI native install (can self-update)
USER claude
# ⚠️  FLOOR, not decoration. `DISABLE_AUTOUPDATER=1` below + the entrypoint's
# `.autoUpdates = false` patch mean the container NEVER moves off this pin — whatever
# is baked here is what every claudebot runs, forever, until someone bumps this line.
# Consequence (#17): Claude Code SILENTLY IGNORES unknown flags (exit 0, no warning),
# so any feature-gating flag dridock forwards to a too-old CLI is accepted and dropped
# with zero diagnostics. 2.1.123 predated Remote Control entirely — no `--remote-control`
# flag, no `remote-control` subcommand — so `dridock start --remote-control` "worked"
# and RC was never activated. Remote Control needs >= 2.1.206 (its full error surface;
# see https://code.claude.com/docs/en/remote-control). Keep this reasonably current, and
# when raising it, re-check the entrypoint's `--remote-control` capability probe.
ARG CLAUDE_VERSION=2.1.215
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- $CLAUDE_VERSION && \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile && \
    ~/.local/bin/claude install --yes 2>/dev/null || true
ENV PATH="/home/claude/.local/bin:$PATH"
ENV DISABLE_AUTOUPDATER=1

# back to root for entrypoint
USER root

# ⚠️  HEADS UP (people & bots): anything you bake into /home/claude/.claude here is
# SHADOWED AT RUNTIME. The wrapper bind-mounts a per-project host dir over
# /home/claude/.claude (see docs/design/per-project-vm.md), so image-baked files
# there are invisible inside the running container. To ship default .claude content
# (config, settings.json, plugins, skills, init.d hooks) you must SEED IT AT RUNTIME
# from the entrypoint into the mounted dir — copy a template that lives OUTSIDE the
# mount (the /claude pattern below), or write/install it in entrypoint.sh. Do NOT add
# `COPY ... /home/claude/.claude/...` expecting it to appear at runtime; it won't.
#
# copy default claude config to /claude (OUTSIDE the mount) for the entrypoint to seed
RUN mkdir -p /claude && \
    cp /home/claude/.claude.json /claude/.claude.json

# workspace
WORKDIR /workspace

# ── harness ──────────────────────────────────────────────────────────────────────
# The VOLATILE layer: entrypoint + Python daemons + cb-* helpers + profiles + CHANGELOG.
# These change on nearly every commit, so they're staged HERE (a cheap ubuntu stage, no
# apt) and COPY --from'd into each variant at the very end — AFTER the expensive toolchain
# — so editing a script or cutting a release never invalidates the Go/npm/pyenv layers.
# The staging layout mirrors the install destinations:
#   /h/home     → /home/claude          (entrypoint, daemons, CHANGELOG)
#   /h/bin      → /usr/local/bin         (cb-* helpers + the host-agent shim colima/limactl)
#   /h/features → /usr/local/lib/dridock/features   (3.0: superset of the 2.x /h/profiles)
#   /h/lib      → /usr/local/lib/dridock             (shared data: env-rename.map, etc.)
FROM ubuntu:24.04 AS harness
RUN mkdir -p /h/home /h/bin /h/features /h/lib
COPY entrypoint.sh api_server.py telegram_bot.py telegram_utils.py cron.py jsonpipe.py /h/home/
# Bake the harness changelog OUTSIDE the mount (/home/claude/.claude is shadowed) so
# claudebot can read it; the entrypoint points claudebot here and flags version bumps.
COPY CHANGELOG.md /h/home/
COPY cb-browser cb-report-bug cb-consult cb-df cb-help cb-harness-watch-consults /h/bin/
COPY cb-host-shim /h/bin/colima
# Unified command surface (#1, 3.0): baked in-container `dridock` shim that
# routes container-side verbs to their cb-* implementation and prints a
# targeted "run on the Mac" message for host-only verbs. `claudebox` stays
# as a symlink for one deprecation cycle (2.x binary name).
COPY dridock /h/bin/dridock
# Features (3.0, #5, supersedes 2.x profiles/): named opt-in bundles a project enables
# via .dridock/config.yml `features: [...]`. Each `features/<name>/` has manifest.yml,
# on.sh (first-enable install), off.sh (disable teardown). The entrypoint runs on.sh
# marker-guarded. `profiles:` is accepted as a config-key alias for one cycle. See
# docs/design/features-system.md.
COPY features/ /h/features/
# Shared env-rename map (#16, 3.2.1): the single source of truth for
# DRIDOCK_X ↔ CLAUDEBOX_X pairs, read by wrapper.sh (host) and entrypoint.sh
# (container) so both sides mirror the two names symmetrically for the whole
# 3.x deprecation cycle. Removed in 4.0. See docs/design/env-var-rename.md.
COPY env-rename.map /h/lib/env-rename.map
RUN chmod +x /h/home/entrypoint.sh /h/bin/* /h/features/*/on.sh /h/features/*/off.sh \
    && ln -sf colima /h/bin/limactl \
    && ln -sf dridock /h/bin/claudebox  # 2.x binary-name compat (one deprecation cycle)

# ── harness install (shared tail) ────────────────────────────────────────────────
# Applied identically at the end of BOTH variants (minimal + full). Dockerfile has no
# macros, so if you change what/where the harness installs, change it in the harness
# stage above AND both `COPY --from=harness` blocks below. The version stamp goes LAST so
# a VERSION bump only rebuilds these trivial final layers, never the toolchain.

# ── minimal ────────────────────────────────────────────────────────────────────
FROM base AS minimal
ENV DRIDOCK_IMAGE_VARIANT=minimal
COPY --from=harness /h/home/ /home/claude/
COPY --from=harness /h/bin/ /usr/local/bin/
COPY --from=harness /h/features/ /usr/local/lib/dridock/features/
COPY --from=harness /h/lib/env-rename.map /usr/local/lib/dridock/env-rename.map
ARG DRIDOCK_VERSION=0.0.0
ENV DRIDOCK_VERSION=$DRIDOCK_VERSION
LABEL org.dridock.version=$DRIDOCK_VERSION
ENTRYPOINT ["/home/claude/entrypoint.sh"]

# ── full ───────────────────────────────────────────────────────────────────────
FROM base AS full
ENV DRIDOCK_IMAGE_VARIANT=full

# build tools
RUN apt-get update && apt-get install -y \
    build-essential make cmake pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# python base
RUN apt-get update && apt-get install -y \
    python3 python3-pip python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# editors and terminal
RUN apt-get update && apt-get install -y \
    nano vim htop tmux \
    && rm -rf /var/lib/apt/lists/*

# archive tools
RUN apt-get update && apt-get install -y \
    unzip zip tar \
    && rm -rf /var/lib/apt/lists/*

# networking tools
RUN apt-get update && apt-get install -y \
    net-tools iputils-ping dnsutils \
    && rm -rf /var/lib/apt/lists/*

# cli tools
RUN apt-get update && apt-get install -y \
    tree fd-find ripgrep bat eza silversearcher-ag \
    shellcheck shfmt httpie gh \
    && rm -rf /var/lib/apt/lists/*

# c/c++ tools
RUN apt-get update && apt-get install -y \
    clang-format valgrind gdb strace ltrace \
    && rm -rf /var/lib/apt/lists/*

# database clients
RUN apt-get update && apt-get install -y \
    sqlite3 postgresql-client default-mysql-client redis-tools \
    && rm -rf /var/lib/apt/lists/*

# pyenv dependencies
RUN apt-get update && apt-get install -y \
    libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# go 1.26.1
ARG TARGETARCH
RUN curl -fsSL https://go.dev/dl/go1.26.1.linux-${TARGETARCH}.tar.gz | tar -xzC /usr/local && \
    echo 'export PATH="$PATH:/usr/local/go/bin"' > /etc/profile.d/go.sh
ENV PATH=$PATH:/usr/local/go/bin

# go tools
RUN curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh | sh -s -- -b /usr/local/bin latest
RUN CGO_ENABLED=0 go install golang.org/x/tools/gopls@latest && mv /root/go/bin/gopls /usr/local/bin/
RUN CGO_ENABLED=0 go install github.com/go-delve/delve/cmd/dlv@latest && mv /root/go/bin/dlv /usr/local/bin/
RUN CGO_ENABLED=0 go install honnef.co/go/tools/cmd/staticcheck@latest && mv /root/go/bin/staticcheck /usr/local/bin/
RUN CGO_ENABLED=0 go install github.com/fatih/gomodifytags@latest && mv /root/go/bin/gomodifytags /usr/local/bin/
RUN CGO_ENABLED=0 go install github.com/josharian/impl@latest && mv /root/go/bin/impl /usr/local/bin/
RUN CGO_ENABLED=0 go install github.com/cweill/gotests/gotests@latest && mv /root/go/bin/gotests /usr/local/bin/
RUN CGO_ENABLED=0 go install mvdan.cc/gofumpt@latest && mv /root/go/bin/gofumpt /usr/local/bin/

# terraform
RUN curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /etc/apt/keyrings/hashicorp.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/hashicorp.list && \
    apt-get update && apt-get install -y terraform && rm -rf /var/lib/apt/lists/*

# kubectl
RUN curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /" | tee /etc/apt/sources.list.d/kubernetes.list && \
    apt-get update && apt-get install -y kubectl && rm -rf /var/lib/apt/lists/*

# helm
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# node.js tools (global)
# Bake the common LSP servers on PATH so their Claude Code `*-lsp` plugins work (the
# plugins ship no binary). Universal, like Go's gopls: typescript-language-server (TS/JS)
# and pyright (Python; provides pyright-langserver). Heavy/niche servers stay per-profile.
RUN npm install -g eslint prettier typescript typescript-language-server pyright ts-node @typescript-eslint/parser @typescript-eslint/eslint-plugin
RUN npm install -g nodemon pm2 yarn pnpm
# Framework scaffolders moved to opt-in `web-scaffolders` feature in 3.2.0 (#14):
# `create-react-app` was deprecated by React in early 2023; `@vue/cli` / `@angular/cli`
# / `express-generator` are niche enough that most projects don't need them baked.
# Enable per-project with `dridock features enable web-scaffolders`. See
# features/web-scaffolders/manifest.yml for the current tool list (includes
# create-vite + create-next-app as the modern CRA replacements).
RUN npm install -g newman http-server serve lighthouse @storybook/cli

# pyenv + python 3.12.11 (system-wide)
ENV PYENV_ROOT="/usr/local/pyenv"
ENV PATH="$PYENV_ROOT/shims:$PYENV_ROOT/bin:$PATH"
RUN curl https://pyenv.run | bash && \
    eval "$(pyenv init -)" && \
    pyenv install 3.12.11 && \
    pyenv global 3.12.11 && \
    echo 'export PYENV_ROOT="/usr/local/pyenv"' > /etc/profile.d/pyenv.sh && \
    echo 'export PATH="$PYENV_ROOT/shims:$PYENV_ROOT/bin:$PATH"' >> /etc/profile.d/pyenv.sh

# python linters/formatters
# pyright is installed via npm above (fully build-time baked, provides pyright-langserver
# for the pyright-lsp plugin); the pip package only lazily downloads node at first run.
RUN pip install --no-cache-dir flake8 black isort autoflake mypy vulture

# python testing
RUN pip install --no-cache-dir pytest pytest-cov

# python libs
RUN pip install --no-cache-dir requests beautifulsoup4 lxml pyyaml toml

# python package managers
RUN pip install --no-cache-dir pipenv poetry

# harness install (shared tail — keep in sync with the minimal variant above)
COPY --from=harness /h/home/ /home/claude/
COPY --from=harness /h/bin/ /usr/local/bin/
COPY --from=harness /h/features/ /usr/local/lib/dridock/features/
COPY --from=harness /h/lib/env-rename.map /usr/local/lib/dridock/env-rename.map
ARG DRIDOCK_VERSION=0.0.0
ENV DRIDOCK_VERSION=$DRIDOCK_VERSION
LABEL org.dridock.version=$DRIDOCK_VERSION
ENTRYPOINT ["/home/claude/entrypoint.sh"]

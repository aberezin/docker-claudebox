FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

# Fork semver — stamped from the VERSION file at build time (Makefile/install.sh pass
# --build-arg). Both a LABEL (read by `claudebox checkversion` via image inspect) and
# an ENV (visible to the running container). Bump VERSION + wrapper.sh on IPC-contract
# changes so host/container drift is detectable.
ARG CLAUDEBOX_VERSION=0.0.0
ENV CLAUDEBOX_VERSION=$CLAUDEBOX_VERSION
LABEL org.claudebox.version=$CLAUDEBOX_VERSION

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
ARG CLAUDE_VERSION=2.1.123
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

# entrypoint + api server
COPY entrypoint.sh /home/claude/entrypoint.sh
COPY api_server.py /home/claude/api_server.py
COPY telegram_bot.py /home/claude/telegram_bot.py
COPY telegram_utils.py /home/claude/telegram_utils.py
COPY cron.py /home/claude/cron.py
COPY jsonpipe.py /home/claude/jsonpipe.py
COPY cb-browser /usr/local/bin/cb-browser
COPY cb-report-bug /usr/local/bin/cb-report-bug
COPY cb-consult /usr/local/bin/cb-consult
COPY cb-df /usr/local/bin/cb-df
COPY cb-host-shim /usr/local/bin/colima
COPY cb-help /usr/local/bin/cb-help
# Profile installers: named tool bundles a project opts into (.claudebox config
# `profiles:`); the entrypoint runs the matching one on first enable. See
# docs/design/profiles.md.
COPY profiles /usr/local/lib/claudebox/profiles
# Bake the harness changelog OUTSIDE the mount (/home/claude/.claude is shadowed) so
# claudebot can read it; the entrypoint points claudebot here and flags version bumps.
COPY CHANGELOG.md /home/claude/CHANGELOG.md
RUN chmod +x /home/claude/entrypoint.sh /usr/local/bin/cb-browser /usr/local/bin/cb-report-bug /usr/local/bin/cb-consult /usr/local/bin/cb-df /usr/local/bin/colima /usr/local/bin/cb-help /usr/local/lib/claudebox/profiles/*.sh \
    && ln -sf colima /usr/local/bin/limactl   # host-agent shim proxies both (Approach 2 / #15)

ENTRYPOINT ["/home/claude/entrypoint.sh"]

# ── minimal ────────────────────────────────────────────────────────────────────
FROM base AS minimal
ENV CLAUDEBOX_IMAGE_VARIANT=minimal

# ── full ───────────────────────────────────────────────────────────────────────
FROM base AS full
ENV CLAUDEBOX_IMAGE_VARIANT=full

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
RUN npm install -g create-react-app @vue/cli @angular/cli express-generator
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

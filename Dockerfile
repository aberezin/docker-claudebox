# The pinned Claude Code CLI version. Declared ONCE, before the first FROM, so
# every stage that needs it inherits the same default via a bare `ARG
# CLAUDE_VERSION` re-declaration. Do not repeat the literal in a stage: the
# builder that INSTALLS the CLI and the stage that LABELS it would drift apart,
# and the label would quietly describe a version that isn't in the image (#78).
# Override at build time: --build-arg CLAUDE_VERSION=2.1.243
# (./install.sh --claude-version <v>|latest|stable does this for you.)
ARG CLAUDE_VERSION=2.1.215

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

# node.js (needed for claude CLI) — from the official nodejs.org tarball,
# arch-detected (same pattern as the Go install below). NodeSource's setup
# scripts started 403'ing (setup_lts.x/setup_22.x) and setup_20.x silently
# falls back to Ubuntu's npm-less node 18 (2026-07), so bypass NodeSource.
RUN NODE_VERSION=20.20.2 && \
    ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in \
      arm64) NODE_ARCH=arm64 ;; \
      amd64) NODE_ARCH=x64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" \
      | tar -xz -C /usr/local --strip-components=1 && \
    node --version && npm --version

# python3 + api server deps (needed for CLAUDE_MODE_API)
#
# ALL SIX are pinned (#65). The failure mode we're defending against is #62:
# an upstream major landing between two rebuilds with no commit here. Unpinned,
# every one of these can do to the daemons what mcp 2.0.0 did to API mode.
#
# Version-specifier shape is deliberate and asymmetric between 0.x and 1.x+:
#   ~=X.Y.Z on 0.x packages   fastapi (0.141.1), uvicorn (0.52.0)
#   ~=X.Y   on 1.x+ packages  python-telegram-bot (22.8), pyyaml (6.0.3),
#                             croniter (6.2.4)
# Reasoning: PEP 440's `~=X.Y.Z` admits patches only (blocks X.Y+1.0), while
# `~=X.Y` admits minors + patches (blocks X+1.0). For 0.x packages, MINORS are
# the breaking bumps by convention (there is no "major" until 1.0), so the
# tighter bound is what actually protects us — fastapi has broken things in a
# 0.x minor before. For 1.x+ packages following real semver, minors are meant
# to be non-breaking and admitting them is the right cost/benefit — closer to
# Arfy's original suggestion in #65.
#
# `mcp<2` stays a HARD upper bound: 2.0.0 removed `mcp.server.fastmcp`
# (renamed to `mcp.server.mcpserver`), and `api_server.py:1141` imports FastMCP
# from the old path at MODULE SCOPE — the whole API server died on import (#62,
# fixed in 4.2.3). Removing `<2` without porting the FastMCP usage re-breaks
# API mode entirely. Same rationale as above but with a known-real ceiling
# rather than a defensive one.
#
# When bumping these deliberately: `pip index versions <pkg>`, run the suite
# (that gate is real now — #63), then update the ~= floor. No cadence document
# because the ~= form doesn't need one; a bump is a code review, not a chore.
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages --ignore-installed \
       "fastapi~=0.141.1" \
       "uvicorn~=0.52.0" \
       "python-telegram-bot~=22.8" \
       "pyyaml~=6.0" \
       "mcp>=1.29,<2" \
       "croniter~=6.2"

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

# claude CLI — the ENV contract only. The install itself lives in the `claude-cli`
# builder stage below and is COPY'd into each variant as one of its LAST layers.
# Why it isn't here: `full` is `FROM base` and then runs nine apt/toolchain blocks,
# so anything at the tail of `base` sits UPSTREAM of them — bumping CLAUDE_VERSION
# would invalidate the entire toolchain and turn a one-line pin change into a full
# rebuild. These two ENVs never change with the version, so they stay cache-stable
# here. Same reasoning as `ARG DRIDOCK_VERSION` being last in each variant.
ENV PATH="/home/claude/.local/bin:$PATH"
ENV DISABLE_AUTOUPDATER=1
# Login shells: Ubuntu's skel .profile already adds ~/.local/bin when it exists, but
# that block is conditional on the dir being present at shell start. Keep the explicit
# export (version-independent, so it stays cached) to preserve pre-4.2.2 behavior.
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/claude/.profile

# ⚠️  HEADS UP (people & bots): anything you bake into /home/claude/.claude here is
# SHADOWED AT RUNTIME. The wrapper bind-mounts a per-project host dir over
# /home/claude/.claude (see docs/design/per-project-vm.md), so image-baked files
# there are invisible inside the running container. To ship default .claude content
# (config, settings.json, plugins, skills, init.d hooks) you must SEED IT AT RUNTIME
# from the entrypoint into the mounted dir — copy a template that lives OUTSIDE the
# mount (the /claude pattern below), or write/install it in entrypoint.sh. Do NOT add
# `COPY ... /home/claude/.claude/...` expecting it to appear at runtime; it won't.
#
# The /claude seed itself is produced by the `claude-cli` stage (it's a byproduct of
# `claude install --yes`) and COPY'd into each variant alongside the CLI.

# workspace
WORKDIR /workspace

# ── claude CLI (builder) ───────────────────────────────────────────────────────
# Installed here and COPY'd into each variant LAST so a version bump costs this stage
# + three small COPY layers per variant, instead of invalidating `base` and every apt
# block in `full` downstream of it.
#
# MUST install under /home/claude: `~/.local/bin/claude` is an ABSOLUTE symlink into
# `~/.local/share/claude/versions/<v>`, so building under any other $HOME (e.g. /root)
# would leave it dangling once COPY'd to /home/claude. Verified: the installer runs
# fine as root with $HOME redirected, and the resulting tree is a static ELF plus that
# symlink — self-contained and relocatable.
#
# Do NOT promote this to a stage that `full`/`minimal` inherit from (`FROM claude-cli`).
# That would put it upstream of full's toolchain layers again and undo the whole point.
#
# ⚠️  FLOOR, not decoration. `DISABLE_AUTOUPDATER=1` in `base` + the entrypoint's
# `.autoUpdates = false` patch mean the container NEVER moves off this pin — whatever
# is baked here is what every claudebot runs, forever, until someone bumps this line.
# Consequence (#17): Claude Code SILENTLY IGNORES unknown flags (exit 0, no warning),
# so any feature-gating flag dridock forwards to a too-old CLI is accepted and dropped
# with zero diagnostics. 2.1.123 predated Remote Control entirely — no `--remote-control`
# flag, no `remote-control` subcommand — so `dridock start --remote-control` "worked"
# and RC was never activated. Remote Control needs >= 2.1.206 (its full error surface;
# see https://code.claude.com/docs/en/remote-control). Keep this reasonably current, and
# when raising it, re-check the entrypoint's `--remote-control` capability probe.
FROM ubuntu:24.04 AS claude-cli
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/home/claude
RUN mkdir -p /home/claude
ARG CLAUDE_VERSION
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- $CLAUDE_VERSION && \
    ~/.local/bin/claude install --yes 2>/dev/null || true
# /claude is the OUTSIDE-the-mount seed the entrypoint copies from at runtime (see the
# HEADS UP block in `base`). Built here because .claude.json is an install byproduct.
RUN mkdir -p /claude && \
    cp /home/claude/.claude.json /claude/.claude.json
# Fail loudly at build time rather than shipping an image whose `claude` is a dangling
# symlink — the failure mode this stage's path constraint exists to prevent.
RUN /home/claude/.local/bin/claude --version

# ── dridock-ts compile ──────────────────────────────────────────────────────────
# Bun-compiled standalone binary for the in-container verbs that need the real TS
# implementation (currently just `team` and its subverbs, via the shim's routing —
# see the `dridock` script). Kept as its own stage so it doesn't touch the toolchain
# layers in `full`; only edits under `dridock-ts/` bust this layer. The final `full`
# image ends up ~90 MB heavier (the compiled binary) — worth it so an in-container
# claudebot can run `dridock team whoami` / `watch --once` for real, not just via a
# shell reimpl. Skipped by the `minimal` target (no team-watch there yet).
FROM ubuntu:24.04 AS dridock-ts-build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Install bun (used at build time only; not shipped in the final image).
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=/root/.bun/bin:$PATH
# Copy only the dridock-ts subtree — edits under other dirs (docs, tests/, wrapper
# scripts, README) do NOT invalidate this cache layer. `bun install --frozen-lockfile`
# needs package.json + bun.lock only; the compile pulls in src/.
COPY dridock-ts/ /build/dridock-ts/
WORKDIR /build/dridock-ts
RUN bun install --frozen-lockfile && \
    mkdir -p /out && \
    bun build --compile src/cli/main.ts --outfile /out/dridock

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
# `find` for check.sh rather than a glob: it is OPTIONAL per feature (#75), so a
# bare /h/features/*/check.sh would fail the build whenever no feature ships one.
# It must still be chmod'd — the entrypoint gates on `[ -x check.sh ]`, so a
# non-executable one is silently ignored and the feature falls back to
# marker-only, which is the bug check.sh exists to prevent.
RUN chmod +x /h/home/entrypoint.sh /h/bin/* /h/features/*/on.sh /h/features/*/off.sh \
    && find /h/features -name check.sh -type f -exec chmod +x {} + \
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
# Compiled dridock binary for the team verbs (the shim routes to it) — see the
# dridock-ts-build stage above and `dridock` (shim) for the routing. Kept off
# $PATH at /usr/local/lib/dridock/ so the shim at /usr/local/bin/dridock owns
# the user-visible `dridock` name (routes container-safe verbs here + host-only
# verbs to a "run on Mac" message).
COPY --from=dridock-ts-build /out/dridock /usr/local/lib/dridock/dridock
RUN chmod +x /usr/local/lib/dridock/dridock
# claude CLI — LAST (see the identical block in `full`).
COPY --from=claude-cli --chown=claude:claude /home/claude/.local/ /home/claude/.local/
COPY --from=claude-cli --chown=claude:claude /home/claude/.claude.json /home/claude/.claude.json
COPY --from=claude-cli /claude/ /claude/
ARG DRIDOCK_VERSION=0.0.0
ENV DRIDOCK_VERSION=$DRIDOCK_VERSION
LABEL org.dridock.version=$DRIDOCK_VERSION
# The pinned CLI, stamped so reseed drift-detection can compare it with a cheap
# `docker image inspect` instead of spawning a throwaway container on every
# launch. Without this, a CLI-only rebuild (same DRIDOCK_VERSION) compared equal
# and never propagated to project VMs (#78). Declared bare to inherit the global
# ARG above. Last in the stage, so changing it rebuilds only this metadata layer.
ARG CLAUDE_VERSION
LABEL org.dridock.claude-version=$CLAUDE_VERSION
ENTRYPOINT ["/home/claude/entrypoint.sh"]

# ── full ───────────────────────────────────────────────────────────────────────
FROM base AS full
ENV DRIDOCK_IMAGE_VARIANT=full

# ⚠️  THESE BLOCKS ARE ORDERED BY VOLATILITY — least-likely-to-change FIRST.
# Docker invalidates every layer after the first changed one, so adding a package to
# an early block rebuilds all nine. Adding one to the LAST block rebuilds only it.
# When you add tooling, put it in the latest block it plausibly belongs to, and add
# new blocks at the END. Don't re-sort alphabetically or by topic — the order IS the
# cache strategy. Kept as separate RUNs on purpose: merging them would speed a cold
# build but collapse the granularity this ordering depends on.

# archive tools — three packages that have not changed since the fork began
RUN apt-get update && apt-get install -y \
    unzip zip tar \
    && rm -rf /var/lib/apt/lists/*

# build tools
RUN apt-get update && apt-get install -y \
    build-essential make cmake pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# python base
RUN apt-get update && apt-get install -y \
    python3 python3-pip python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# pyenv dependencies — fixed by pyenv's documented build requirements, not by us
RUN apt-get update && apt-get install -y \
    libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

# c/c++ tools
RUN apt-get update && apt-get install -y \
    clang-format valgrind gdb strace ltrace \
    && rm -rf /var/lib/apt/lists/*

# networking tools
RUN apt-get update && apt-get install -y \
    net-tools iputils-ping dnsutils \
    && rm -rf /var/lib/apt/lists/*

# editors and terminal
RUN apt-get update && apt-get install -y \
    nano vim htop tmux \
    && rm -rf /var/lib/apt/lists/*

# database clients — grows when a project needs a new engine's client
RUN apt-get update && apt-get install -y \
    sqlite3 postgresql-client default-mysql-client redis-tools \
    && rm -rf /var/lib/apt/lists/*

# cli tools — MOST VOLATILE, keep last. New dev CLIs land here.
RUN apt-get update && apt-get install -y \
    tree fd-find ripgrep bat eza silversearcher-ag \
    shellcheck shfmt httpie gh \
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
COPY --from=dridock-ts-build /out/dridock /usr/local/lib/dridock/dridock
RUN chmod +x /usr/local/lib/dridock/dridock
# claude CLI — LAST, so a CLAUDE_VERSION bump rebuilds only these three COPY layers and
# the claude-cli stage, never the toolchain above. Keep it after the harness COPYs.
COPY --from=claude-cli --chown=claude:claude /home/claude/.local/ /home/claude/.local/
COPY --from=claude-cli --chown=claude:claude /home/claude/.claude.json /home/claude/.claude.json
COPY --from=claude-cli /claude/ /claude/
ARG DRIDOCK_VERSION=0.0.0
ENV DRIDOCK_VERSION=$DRIDOCK_VERSION
LABEL org.dridock.version=$DRIDOCK_VERSION
# The pinned CLI, stamped so reseed drift-detection can compare it with a cheap
# `docker image inspect` instead of spawning a throwaway container on every
# launch. Without this, a CLI-only rebuild (same DRIDOCK_VERSION) compared equal
# and never propagated to project VMs (#78). Declared bare to inherit the global
# ARG above. Last in the stage, so changing it rebuilds only this metadata layer.
ARG CLAUDE_VERSION
LABEL org.dridock.claude-version=$CLAUDE_VERSION
ENTRYPOINT ["/home/claude/entrypoint.sh"]

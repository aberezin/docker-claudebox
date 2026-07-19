# dridock

[![License: WTFPL](https://img.shields.io/badge/License-WTFPL-brightgreen.svg?style=flat-square)](http://www.wtfpl.net/)

> **This is a fork, rebranded in 3.0.** The upstream project is [psyb0t/docker-claudebox](https://github.com/psyb0t/docker-claudebox) (`claudebox`). This fork keeps the same interfaces but was renamed to **`dridock`** at 3.0 and re-targets the harness to run under **[Colima](https://github.com/abiosoft/colima) with an isolated per-project VM**, adding **docker-out-of-docker orchestration** (claudebot spins up and wires sibling workload containers), a **no-sudo local-build install**, and per-project bootstrapping, browser testing, and plugins. It builds the image **locally** and pulls nothing from Docker Hub. Legacy 2.x env vars (`CLAUDEBOX_*`) and project dirs (`.claudebox/`) are still accepted for one deprecation cycle — see [3.0 migration guide](docs/design/3.0-migration.md). For the fork's rationale see [What's different in this fork](#whats-different-in-this-fork).

A runtime harness for [Claude Code](https://claude.com/product/claude-code) — the agentic coding CLI from Anthropic — running in a fully isolated Docker container with every dev tool pre-installed, passwordless sudo, docker-in-docker support, and `--dangerously-skip-permissions` enabled by default.

dridock wraps Claude Code with several distinct interfaces:

- **Interactive CLI (`dridock`)** — a drop-in replacement for the native `claude` command, with persistent containers and automatic session resumption across runs
- **Programmatic CLI** — non-interactive mode for scripts, CI/CD pipelines, and automation; pass a prompt, get structured output, pipe it wherever you need
- **HTTP API server** — a full REST API with workspace management, file operations, structured output formats, and workspace isolation for multi-tenant deployments
- **OpenAI-compatible endpoint** — a `chat/completions` adapter that lets LiteLLM, OpenAI SDKs, and any OpenAI-compatible client talk to Claude Code, complete with streaming SSE, multi-turn conversations, and multimodal image handling
- **MCP server** — a [Model Context Protocol](https://modelcontextprotocol.io/) endpoint over streamable HTTP so other AI agents and tools (Claude Desktop, other Claude Code instances, etc.) can use Claude Code as a tool
- **Telegram bot** — a conversational interface with per-chat workspaces, configurable models and effort levels, file sharing, shell access, and group chat support
- **Cron scheduler** — yaml-defined Claude jobs running on cron schedules with per-job activity history, sub-minute resolution, and overlap protection

Beyond just running Claude Code in Docker, dridock adds skill injection (auto-load `SKILL.md` files into every session), init hooks, custom script directories, structured JSON logging, and a workspace management layer that handles multi-tenant isolation with automatic busy/idle tracking.

## What's different in this fork

Everything above is inherited from upstream claudebox. This fork re-targets it for a
Colima-based, orchestration-first workflow:

- **A dedicated Colima VM per project** (`cb-<id>`), shared-nothing — the default VM
  stays human-only, and each claudebot only ever sees/manages its own containers. See
  [docs/design/per-project-vm.md](docs/design/per-project-vm.md).
- **Docker-out-of-docker orchestration** — claudebot spins up and networks *sibling*
  workload containers (an API server, a database, …) under its VM, so it can build and
  test multi-tier apps. The [todo-app example](examples/todo-app/) does this end-to-end.
- **Local build only** — nothing is pulled from Docker Hub; the wrapper runs the
  `dridock:latest` image you build from this checkout (into a `cb-infra` image-store VM).
- **No-sudo userspace install** — installs to `~/.local/bin` by default.
- **Reachable per-project VM IPs** — published workloads are browsable from your Mac at
  the VM's own IP (collision-free across projects).
- **Project workflow additions** — `dridock bootstrap` (mission-brief handoff),
  `cb-browser` + an opt-in CDP bridge (browser testing), `cb-report-bug` (framework bug
  reports), per-project plugins, and `cbx-*` shell helpers.

## Table of Contents

- [What's different in this fork](#whats-different-in-this-fork)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Image Variants](#image-variants)
- [What's Inside (Full Image)](#whats-inside-full-image)
- [Authentication](#authentication)
- [Modes](#modes)
- [Configuration](#configuration)
- [Gotchas](#gotchas)
- [License](#license)

## Requirements

This fork runs on **macOS under [Colima](https://github.com/abiosoft/colima)** and gives every project its own Colima VM (see [docs/design/per-project-vm.md](docs/design/per-project-vm.md)). You need:

- **Colima + the Docker CLI** — `port install colima docker` (MacPorts) or `brew install colima docker`.
- **`socket_vmnet`** — required so each project VM gets a **host-reachable IP** (workloads become browsable at `http://<vm-ip>:<port>`). Install it (`port install socket_vmnet` / `brew install socket_vmnet`), then do the **one-time** passwordless-sudo setup below.

### One-time networking setup (`socket_vmnet`)

Project VMs are started with `colima start --network-address` to get a reachable IP. Without `socket_vmnet` configured, that prompts for your macOS password on **every** VM start. To make it sudo-free, install `socket_vmnet` and authorize it once:

```bash
# after installing socket_vmnet (port/brew):
limactl sudoers | sudo tee /etc/sudoers.d/lima     # one-time; the only sudo dridock needs
limactl sudoers --check /etc/sudoers.d/lima        # validate
```

`limactl sudoers` auto-detects the `socket_vmnet` path (MacPorts `/opt/local/bin` or Homebrew), so the generated file is correct either way. After this, `dridock` never prompts for a password at runtime.

## Quick Start

> **Local build, no registry.** Nothing is pulled from Docker Hub — the installer builds the image from this checkout with `docker build`, and the wrapper runs that local `dridock:latest`.

### Install

Clone the repo and run the installer from the checkout. It builds the image locally with `docker build`, generates SSH keys for git operations inside the container, and installs the wrapper as a command on your system.

```bash
git clone <your-fork-url> dridock && cd dridock

# full image (recommended — all dev tools pre-installed)
./install.sh

# minimal image (just the essentials — Claude installs what it needs on the fly)
export DRIDOCK_MINIMAL=1 && ./install.sh

# custom binary name (e.g. if you want to call it 'claude' instead of 'dridock')
./install.sh claude
# or: export DRIDOCK_BIN_NAME=claude && ./install.sh
```

The installer must run from a checkout of the repo — it needs the `Dockerfile` and `wrapper.sh` beside it, and it will not pipe from `curl` since there is no registry image to fall back to.

### Manual setup

If you prefer to do it by hand:

```bash
# 1. create the data directory
mkdir -p ~/.claude

# 2. create SSH keys for git operations inside the container
mkdir -p "$HOME/.ssh/claudebox"
ssh-keygen -t ed25519 -C "claude@claude.ai" -f "$HOME/.ssh/claudebox/id_ed25519" -N ""
# then add the public key to GitHub/GitLab/wherever you push code

# 3. build the image locally
make build
# or minimal: make build-minimal

# 4. install the wrapper script as a command (no sudo — user-writable dir)
mkdir -p ~/.local/bin && install -m 755 wrapper.sh ~/.local/bin/dridock
# make sure ~/.local/bin is on your PATH (add to ~/.zshrc if needed)
```

### Create a new claudebot project (`dridock bootstrap`)

To stand up a fresh project *and hand claudebot the reason it's being created*, use
`bootstrap`. It runs a **preflight** (asserts `colima`/`docker`/`git` are present),
`git init`s the repo, scaffolds a starter layout, and writes a **committed mission
brief** at `.dridock/BRIEF.md`. On first boot, claudebot is pointed at that brief
(a banner is prepended to its `CLAUDE.md`) so it starts knowing *why* it exists.

```bash
mkdir project-a && cd project-a
dridock bootstrap "Build a 3-tier app: React UI, Node API, Postgres, all in containers."
#   ...or pipe a longer brief:   dridock bootstrap < intent.md
#   ...or from a file:           dridock bootstrap --brief-file intent.md
```

Flags: `--no-start` (scaffold but don't boot claudebot — a host Claude session uses
this, then tells you to `cd project-a && dridock`), `--brief-only` (just the brief
+ config, no git/dirs/boot), `--force` (overwrite an existing brief). As claudebot
works it keeps the brief's *Progress / handoff log* current, so any later session
catches up from one file. See [docs/design/bootstrap.md](docs/design/bootstrap.md).

### Shell into a project's VM and containers (`cbx-*` helpers)

`install.sh` also installs `claudebox-shell.sh` and sources it from your rc, adding
convenience functions (with tab-completion) for getting a shell into the layers of a
project — all scoped to that project's Colima VM (resolved from `.dridock/config.yml`,
falling back to legacy `.claudebox/config.yml`, so they work from any subdirectory):

```bash
cbx-ps                 # list containers running in this project's VM
cbx-sh <name>          # interactive shell in a container  (cbx-sh <TAB> completes names)
cbx-sh <name> node -v  # or run a one-off command in it
cbx-logs <name> -f     # docker logs for a container
cbx-vm                 # ssh into the project VM (the Lima guest) itself
cbx-claude             # shell into claudebot's own harness container (when a session is up)
cbx-claude-dir [-o]    # print (or -o open) this project's host .claude data dir
cbx-up                 # ensure this project's VM (+ its workloads) is running
cbx-up-all             # ensure EVERY dridock VM (+ workloads) is running
```

After a Colima or Mac restart, all per-project VMs (and their workloads) are down.
`cbx-up-all` starts every `cb-*` VM; workloads with `--restart` policies return with
the daemon, and any stopped workload containers without one are started too (the
ephemeral `claude-*` harness containers are skipped). `cbx-up` does the same for just
the current project.

Each project's claudebot config/session/auth lives in its own host dir
(`~/.config/dridock/projects/<id>/claude`, mounted at `/home/claude/.claude`; legacy
2.x projects are under `~/.config/claudebox/projects/…` until `dridock migrate`
moves them) — this fork is shared-nothing, so there's no global `~/.claude`.
`dridock claude-dir` prints that path for the current project.

**Init hooks.** Drop executable `*.sh` scripts in that dir's `init.d/` (i.e.
`$(dridock claude-dir)/init.d/`) and the entrypoint runs them **once**, on first
container create, before starting claudebot — handy for per-project setup. They're
skipped on container reuse (a marker in the container filesystem). This inherited
behavior is covered by `tests/test_e2e.sh::test_e2e_init_hook_runs_once`.

Skip installing them with `DRIDOCK_SKIP_SHELL_HELPERS=1 ./install.sh`, or source
`claudebox-shell.sh` manually from a checkout.

## Image Variants

### `dridock:latest` (full)

Everything pre-installed. Go, Python, Node.js, C/C++ toolchains, Terraform, kubectl, database clients, linters, formatters — the works. Large image, but Claude wakes up and gets to work immediately with zero wait time. This is the recommended variant for most users.

```bash
./install.sh    # or: make build
```

### `dridock:latest-minimal`

Just enough to run Claude: Ubuntu, git, curl, Node.js, and Docker. Claude has passwordless sudo, so it will install whatever else it needs on the fly via `apt-get`, `pip`, `npm`, etc. Smaller image to build, but the first run takes longer as Claude sorts out its dependencies.

```bash
export DRIDOCK_MINIMAL=1 && ./install.sh    # or: make build-minimal
```

Use `~/.claude/init.d/*.sh` hooks (see [Init Hooks](docs/customization.md#init-hooks-claudeinitd)) to pre-install your tools on first container create so Claude doesn't burn tokens figuring out package management.

### Comparison

|                                       | `latest` (full) | `latest-minimal` |
| ------------------------------------- | :-------------: | :--------------: |
| Ubuntu 24.04                          |       yes       |       yes        |
| git, curl, wget, jq                   |       yes       |       yes        |
| Node.js LTS + npm                     |       yes       |       yes        |
| Docker CE + Compose                   |       yes       |       yes        |
| Claude Code CLI                       |       yes       |       yes        |
| Go 1.26.1 + tools                     |       yes       |        -         |
| Python 3.12.11 + tools                |       yes       |        -         |
| Node.js dev tools                     |       yes       |        -         |
| C/C++ tools                           |       yes       |        -         |
| DevOps (terraform, kubectl, helm, gh) |       yes       |        -         |
| Database clients                      |       yes       |        -         |
| Shell utilities (ripgrep, bat, etc.)  |       yes       |        -         |

## What's Inside (Full Image)

**Languages and runtimes:**

- **Go 1.26.1** with the full toolchain — golangci-lint, gopls, delve, staticcheck, gofumpt, gotests, impl, gomodifytags
- **Python 3.12.11** via pyenv — flake8, black, isort, autoflake, pyright, mypy, vulture, pytest, poetry, pipenv, plus common libraries (requests, beautifulsoup4, lxml, pyyaml, toml)
- **Node.js LTS** — eslint, prettier, typescript, typescript-language-server, ts-node, yarn, pnpm, nodemon, pm2, framework CLIs (React, Vue, Angular), newman, http-server, serve, lighthouse, storybook
- **C/C++** — gcc, g++, make, cmake, clang-format, valgrind, gdb, strace, ltrace
- **Language servers (for the `*-lsp` code-intelligence plugins):** `gopls` (Go), `typescript-language-server` (TS/JS), `pyright` (Python) — baked so their plugins work once enabled (via a [profile](docs/design/profiles.md) or init.d). Heavy/niche servers install per profile.

**DevOps and infrastructure:**

- Docker CE with Docker Compose (docker-in-docker support)
- Terraform, kubectl, helm, GitHub CLI (`gh`)

**Database clients:**

- sqlite3, postgresql-client (`psql`), mysql-client, redis-tools (`redis-cli`)

**Shell and system utilities:**

- jq, tree, ripgrep, bat, exa, fd-find, ag (silversearcher), htop, tmux, shellcheck, shfmt, httpie, vim, nano
- Archive tools (zip, unzip, tar), networking (net-tools, iputils-ping, dnsutils)

**Container automation:**

- Auto-generated `CLAUDE.md` in each workspace listing all available tools, so Claude knows what it has access to
- Git identity auto-configured from environment variables
- Claude Code CLI with auto-updates disabled by default (opt in with `--update`)
- Workspace trust dialog pre-accepted — no interactive prompts
- Baked **`cb-*` helper commands** — `cb-browser` (self-contained browser testing), `cb-report-bug` (file a framework bug to the host), `cb-help` (list them). See [convenience scripts](docs/design/convenience-scripts.md).
- **Profiles** — opt-in tool bundles (`profiles: [typescript, python, …]` in `.dridock/config.yml`) that enable code-intelligence plugins on first run. See [profiles](docs/design/profiles.md).
- A container-side **`/dridock` skill** so the claudebot can self-report its harness version, tools, and environment.
- Custom scripts via `~/.claude/bin` (added to PATH automatically)
- Init hooks via `~/.claude/init.d/*.sh` (run once on first container create)
- Always-active skills via `~/.claude/.always-skills/` (injected into every invocation)
- Session continuity via `--continue` / `--no-continue` / `--resume <session_id>`
- Structured JSON debug logging with `DEBUG=true`

## Authentication

You need either an Anthropic API key or an OAuth token. Set up once, use everywhere:

```bash
# interactive OAuth token setup (one-time)
dridock setup-token

# then use the token for programmatic and headless runs
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx dridock "do stuff"

# or use an API key directly
ANTHROPIC_API_KEY=sk-ant-api03-xxx dridock "do stuff"
```

**Using your Claude subscription (not the API):** dridock forwards a host
`ANTHROPIC_API_KEY` into the container, and Claude Code prefers it over subscription
auth. If you usually want the **subscription** (browser OAuth via `dridock
setup-token`), block the key so it's never sent:

```bash
export DRIDOCK_NO_API_KEY=1   # put in ~/.zshrc to make it the default
```

This drops the API key even if one is exported on your Mac (and clears one already
baked into an existing container), so claudebot falls through to the subscription.

## Modes

dridock can run in several modes — pick the one that matches how you want to use Claude Code. Each has its own page with full setup, env vars, and examples.

### [Interactive Mode →](docs/modes/interactive.md)

Drop-in replacement for `claude`. Persistent per-workspace container, automatic session resumption, plus utility commands like `dridock doctor`, `dridock mcp list`, `dridock stop`, and `dridock clear-session`.

```bash
dridock
```

### [Programmatic Mode →](docs/modes/programmatic.md)

Non-interactive prompt → response for scripts, pipelines, and automation. Plain text, JSON, JSON-verbose (with full tool-call history), and stream-json output formats. Model selection, system prompt overrides, JSON-schema-constrained output, session continuation.

```bash
dridock "explain this codebase" --output-format json --model haiku
```

### [API Mode →](docs/modes/api.md)

Run as a long-lived HTTP server. Full REST API for prompts and file ops with workspace isolation, async runs with run-id polling, OpenAI-compatible `chat/completions` endpoint (streaming + multimodal + LiteLLM compatible), and an [MCP](https://modelcontextprotocol.io/) endpoint over streamable HTTP so other agents can use Claude Code as a tool.

```yaml
environment:
  - DRIDOCK_MODE_API=1
  - DRIDOCK_MODE_API_TOKEN=your-secret-token
```

### [Telegram Mode →](docs/modes/telegram.md)

Talk to Claude from Telegram. Per-chat isolated workspaces, configurable models/effort/system-prompts per chat, allowed-chats and per-chat allowed-users gating, file/photo/video/voice ingestion, `/bash`, `/fetch`, `/cancel`, `/status`, `/config`, `/reload` commands, and `[SEND_FILE: path]` for Claude to send files back.

```yaml
environment:
  - DRIDOCK_MODE_TELEGRAM=1
  - DRIDOCK_TELEGRAM_BOT_TOKEN=...
```

### [Cron Mode →](docs/modes/cron.md)

YAML-defined scheduled jobs. Standard 5-field cron or 6-field for sub-minute resolution. Per-job stream-json history under `~/.claude/cron/history/<workspace-slug>/<ts>-<job>/`, foreground process so `docker logs` shows every tick, overlap protection. Set `model` at the root of the YAML as a default for all jobs; override per-job as needed.

```yaml
environment:
  - DRIDOCK_MODE_CRON=1
  - DRIDOCK_MODE_CRON_FILE=/home/claude/.claude/cron.yaml
```

## Configuration

- **[Environment variables →](docs/environment-variables.md)** — full table of `DRIDOCK_*` settings the wrapper and entrypoint understand (legacy `CLAUDEBOX_*` accepted), plus `DRIDOCK_ENV_*` (forward arbitrary vars into the container) and `DRIDOCK_MOUNT_*` (extra volume mounts).
- **[Customization →](docs/customization.md)** — extend Claude's container with custom scripts (`~/.claude/bin`), one-time init hooks (`~/.claude/init.d`), always-active skills auto-injected into every session (`~/.claude/.always-skills`), and MCP server definitions (project `.mcp.json` or global `~/.claude.json`).

## Gotchas

- **`--dangerously-skip-permissions`** is always enabled. Claude has full, unrestricted access to the container. That's the entire point.
- **SSH keys** are mounted from the host for git push/pull inside the container. Do not share your container or image with untrusted parties.
- **Host paths are preserved** — your project at `/home/you/project` is mounted at the same path inside the container. This means Docker volume mounts that Claude creates from within the container resolve correctly against host paths.
- **File ownership just works** — files that Claude creates in your workspace come back owned by **you** on the Mac, no manual `chown` needed. Under Colima this is handled by the VM's virtiofs mount, which maps every container-side write back to the host user regardless of the in-container UID — so the entrypoint's Linux-style UID/GID matching is a harmless no-op here (it stats the mount, sees root, and skips).
- **Docker-in-Docker** — the Docker socket is mounted into the container. Claude can build images and run containers from within its container. This is by design.
- **Two containers per workspace** — the wrapper creates `claude-<path>` for interactive (TTY) sessions and `claude-<path>_prog` for programmatic (no TTY) sessions. Both share the same mounted volumes and data.
- **Workspace busy tracking** — in API mode, each workspace can only have one active Claude process at a time. Concurrent requests to the same workspace return a 409 Conflict response. Use different workspace subpaths for parallel work.
- **Telegram config is required** — the Telegram bot will not start without a `telegram.yml` config file. This is intentional to prevent accidentally exposing Claude to the public.
- **Auto-updates disabled** — Claude Code CLI auto-updates are disabled by default inside the container to ensure reproducible behavior. Opt in with `dridock --update` when you want to update.

## Documentation

📚 **[Full documentation index & table of contents →](docs/README.md)**

- **Modes:** [interactive](docs/modes/interactive.md) · [programmatic](docs/modes/programmatic.md) · [API](docs/modes/api.md) · [Telegram](docs/modes/telegram.md) · [cron](docs/modes/cron.md)
- **Config:** [environment variables](docs/environment-variables.md) · [customization](docs/customization.md)
- **Design:** [per-project VM](docs/design/per-project-vm.md) · [versioning & releases](docs/versioning.md) · [3.0 migration guide](docs/design/3.0-migration.md) · [bootstrap](docs/design/bootstrap.md) · [git & API auth](docs/design/git-and-api-auth.md) · [multi-repo projects](docs/design/multi-repo-projects.md) · [profiles](docs/design/profiles.md) · [browser testing](docs/design/browser-testing.md) · [N-tier networking](docs/design/n-tier-networking.md) · [disk management](docs/design/disk-management.md) · [framework guidance](docs/design/framework-guidance.md) · [framework consult](docs/design/framework-consult.md) · [backends](docs/design/backends.md) · [developing in a dridock](docs/design/developing-in-a-claudebox.md) · [framework bug reporting](docs/design/framework-bug-reporting.md) · [framework-dev mode](docs/design/framework-dev-mode.md) · [convenience scripts (`cb-*`)](docs/design/convenience-scripts.md) · [upstream sync](docs/design/upstream-sync.md) · [features system (3.0 design)](docs/design/features-system.md)
- **Meta:** [documenting dridock](docs/documentation.md) (house style + Mermaid) · [CHANGELOG](CHANGELOG.md) · [CLAUDE.md](CLAUDE.md) (repo conventions)

## License

[WTFPL](http://www.wtfpl.net/) — do what the fuck you want to.

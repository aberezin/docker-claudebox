# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is Alan's fork of claudbox.  Alan wants to customize parts of the docker image and run under colima. To that end, install or startup scripts must use a local image, not a docker hosted one from the upstream. The ultimate goal will be a DooD Docker out of Docker setup wherein the dockerized claude will be able to spin up and orchestrate other docker containers that represent test envs for some given project.  To clarify, consider a concrete example:

This project: ClaudeBoxAlan.  This project yields a docker image (or many) that can run claude along with scripts to operate claude.
Another project: Project-A which is building a multitier app that runs in containers. Some instance of Claude is building this app as part of that effort must be able to spin up containers and ensure that those containers can talk to each other.

Container 1: The env for ClaudeBoxAlan to code for Project-A. This env is spun up under colima.  This env can talk to colima to spin additional workloads which are outside Env1. This env would know nothing about ClaudeBoxAlan other than perhaps some docs or metadata saying how it was created.  ClaudeBoxAlan will however need to be very smart about setting up networking, for example, so that this env can talk to othe envs outside of its container.  It will be the responsibility of Claude running in Container 1 to understand how to orchestate workloads that are under colima.  But we want ClaudeboxAlan to enforce some standard way of doing this.  This is important because if there is a project B coded by a different Claude instance, we want it to do orchration of workloads the same way.
Container 2: An environment that Env1 spins up using colima.  This could be a test workload like an API server. 
Container 3: An environment that Env1 spins up using colima.  This could be a postgresql database.


claudebox is a **runtime harness** that packages the Claude Code CLI inside a Docker container and exposes it through several interfaces (interactive CLI, programmatic CLI, HTTP/OpenAI/MCP API, Telegram bot, cron scheduler). This repo is the harness — it does *not* contain Claude Code itself; Claude Code is installed into the image via npm at build time. Everything here is either the Docker image definition, the shell orchestration around it, or the Python daemons that run the non-interactive modes.

The published image is `psyb0t/claudebox` (full) and `psyb0t/claudebox:latest-minimal`. The project was renamed from `docker-claude-code`; `CLAUDEBOX_*` env vars are canonical and `CLAUDE_*` names are kept as backwards-compatible fallbacks throughout (`${CLAUDEBOX_X:-${CLAUDE_X:-default}}`).

## Build, test, run

```bash
make build            # docker build --target full   -> psyb0t/claudebox:latest
make build-minimal    # docker build --target minimal -> psyb0t/claudebox:latest-minimal
make build-all
make test             # == bash test.sh  (builds the :test minimal image, runs all bash tests)
make clean            # remove built images

# Bash integration tests (require Docker + tests/.env with CLAUDE_CODE_OAUTH_TOKEN)
bash test.sh                      # run every test
bash test.sh test_wrapper         # run one test function by name
bash test.sh test_api test_cron   # run a subset
# per-test logs land in tests/logs/<testname>.log

# Python unit tests (no Docker, no token needed — pure helper functions)
python -m pytest tests/test_api_server_oai.py -v
python -m pytest tests/test_md_to_tg_html.py -v
python tests/test_api_server_oai.py     # each file is also directly runnable
```

`tests/.env` is mandatory for the bash suite — copy `tests/.env.example` and set `CLAUDE_CODE_OAUTH_TOKEN`. The bash tests build a throwaway `psyb0t/claudebox:test` minimal image, spin up real containers, and hit the live Claude API with the `haiku` model (fast/cheap). The Python unit tests are the exception: they import helpers from `api_server.py` / `telegram_utils.py` and never touch Docker or the API — run them for quick iteration on pure logic. Note `make test` / `test.sh` do **not** run the Python unit tests; invoke those separately.

## Architecture — request flow

There are two layers. The **host layer** (`wrapper.sh`) decides *which container and which mode* to run; the **container layer** (`entrypoint.sh`) decides *what to exec inside* the container. Understanding the split is the key to this codebase.

### Host layer: `wrapper.sh`

Installed as the user-facing binary (default name `claudebox`). Everything the user types goes here first. Responsibilities:
- Derives a per-workspace container name from `$PWD` (slashes → underscores): `claude-<sanitized-pwd>`.
- Assembles the shared `DOCKER_ARGS` (mounts `~/.claude`, `~/.ssh/claudebox`, the Docker socket, and `$PWD` **at the same host path inside the container** — this is deliberate so docker-in-docker volume mounts resolve correctly on the host).
- Forwards auth and `CLAUDEBOX_ENV_*` vars, and `CLAUDEBOX_MOUNT_*` extra volumes.
- Writes auth to `~/.claude/.<container>-auth` files so long-lived / restarted containers (which `docker start` can't pass new env to) can re-read credentials.
- Routes to one of several **container roles**, each a distinct container name sharing the same volumes:
  - `claude-<pwd>` — interactive TTY session (`docker run -it` / `docker start -ai`).
  - `claude-<pwd>_prog` — programmatic/non-interactive (`-p`). Args are validated against an allowlist here; for subsequent runs the args are handed off via a `.<container>_prog-args` file and `docker start -a`.
  - `claude-<pwd>_cron` — long-running cron daemon (`docker run -d`).
- Handles utility subcommands that bypass the entrypoint (`stop`, `clear-session`) or run in throwaway containers (`setup-token`, `-v/--version/doctor/auth/mcp`).
- The programmatic path validates flags strictly (only `-p`, `--output-format`, `--model`, `--system-prompt`, `--append-system-prompt`, `--json-schema`, `--effort`, `--resume`, `--no-continue`, `--update` are allowed) and post-processes JSON output by piping through `jsonpipe.py` in a second throwaway container.

### Container layer: `entrypoint.sh`

Runs as root (PID 1) inside every container, then drops to the `claude` user via `setpriv`. Responsibilities, in order:
1. Fix the Docker socket group GID and match the `claude` user's UID/GID to the mounted workspace owner (so files created inside are owned correctly on the host).
2. Generate (once) `~/.claude/CLAUDE.md.template` — the auto-injected per-workspace tool inventory, which differs by image variant (`full` vs `minimal`) — and a `system-hint.txt` appended to every invocation via `--append-system-prompt`. Copy the template into the workspace as `CLAUDE.md` if absent.
3. Patch `.claude.json` (`installMethod=native`, disable auto-updates, pre-accept the workspace trust dialog).
4. Run `~/.claude/init.d/*.sh` **once** on first container create (guarded by `/var/run/claude-initialized`, which lives in the container fs, not the mount).
5. **Mode dispatch** via `CLAUDEBOX_MODE_*`: if `API`, `TELEGRAM`, `CRON`, or combined `TELEGRAM+CRON` is set, `exec` the corresponding Python daemon instead of Claude and stop here.
6. Otherwise build the `claude --dangerously-skip-permissions ...` command. Note the **auto-continue** logic: interactive and programmatic runs default to `--continue` (resume the session) and fall back to a fresh session if that fails; `--no-continue` / `--resume` opt out. Always-active skills from `~/.claude/.always-skills/**/SKILL.md` are concatenated into the `--append-system-prompt` payload here.

`--dangerously-skip-permissions` is *always* passed. That is the intended design — the container is the isolation boundary.

### Python daemons (the non-interactive modes)

Each is `exec`'d by the entrypoint as the `claude` user and shells out to the `claude` CLI as subprocesses:

- **`api_server.py`** — a single FastAPI app (~1400 lines) serving three surfaces on one port:
  - Native REST: `/run` (sync + async via run-id), `/run/result`, `/run/cancel`, `/files/*`, `/health`, `/status`.
  - OpenAI-compatible: `/openai/v1/chat/completions` (streaming SSE, multi-turn, multimodal image ingestion incl. data-URI and remote-URL fetch with an SSRF guard) and `/openai/v1/models`.
  - MCP: `_mcp` (FastMCP) tools mounted over streamable HTTP with a bearer-auth wrapper.
  - Cross-cutting: bearer-token auth (`CLAUDEBOX_MODE_API_TOKEN`), workspace resolution/isolation under `/workspaces`, **one active run per workspace** (concurrent → 409), and camelCase key normalization on responses (`_to_camel` / `_normalize_keys`). When editing, keep the OpenAI shapes byte-compatible with real OpenAI clients — the Python unit tests pin the hardened behaviors.
- **`telegram_bot.py`** — python-telegram-bot app. Per-chat isolated workspaces, per-chat model/effort/system-prompt overrides persisted to a JSON overrides file, allowed-chats/allowed-users gating, file/photo/video/voice ingestion, `/bash` `/fetch` `/cancel` `/status` `/config` `/reload` commands, and `[SEND_FILE: path]` extraction so Claude can send files back. Requires a `telegram.yml` config (won't start without it — intentional, to avoid public exposure).
- **`telegram_utils.py`** — `md_to_tg_html()` converts Claude's markdown to Telegram-safe HTML; `make_bot()` factory. Covered by `tests/test_md_to_tg_html.py`.
- **`cron.py`** — a self-contained scheduler (uses `croniter`) supporting standard 5-field and 6-field (sub-minute) cron. Runs jobs foreground so `docker logs` shows every tick, with overlap protection, per-job stream-json history under `~/.claude/cron/history/<workspace-slug>/<ts>-<job>/`, a history-hint fed back into the next run, and optional Telegram notification of results. Root-level `model`/`effort` in the YAML are defaults; jobs override.
- **`jsonpipe.py`** — stdin→stdout post-processor for the wrapper's programmatic JSON modes. Reassembles Claude's `stream-json` into a `json` or `json-verbose` shape, camelCases keys, and truncates large tool-result content. Runs in its own throwaway container in `wrapper.sh`.

### Dockerfile

Multi-stage: `base` (Ubuntu 24.04 + Node/npm + Docker CE + Claude Code CLI + the Python runtime deps for the daemons: `fastapi uvicorn python-telegram-bot pyyaml mcp croniter`) → `minimal` target (base only) and `full` target (adds Go, pyenv Python, C/C++, DevOps, DB clients, shell tooling, and their linters/formatters). The harness scripts (`entrypoint.sh`, `wrapper.sh` isn't baked — it's the host binary; the Python files, `jsonpipe.py`) are copied into `/home/claude`.

## Conventions worth knowing

- **Env var naming**: always read as `${CLAUDEBOX_X:-${CLAUDE_X:-default}}`. When adding a new setting, follow this dual-prefix pattern and document it in `docs/environment-variables.md`.
- **API responses are camelCase.** Internal Python is snake_case; the boundary converts. `tests/common.sh` has `assert_no_snake_keys` to enforce this on API responses — don't leak snake_case keys out of the HTTP layer.
- **Container-role naming is load-bearing.** The `_prog` / `_cron` suffixes and the `.<container>-auth` / `-secrets` / `-args` / `-update` / `-no-continue` sidecar files in `~/.claude/` are the IPC mechanism between the host wrapper and restarted containers. Keep the naming in `wrapper.sh` and `entrypoint.sh` in sync. (`-secrets` mirrors `-auth`: the wrapper copies `.claudebox/secrets.env` into per-role sidecars each run and the entrypoint re-`export`s them on every start, so secrets survive `docker start` — which can't take new `-e` env.)
- **Versioning is a host↔image contract, not decoration.** The fork's semver lives in the `VERSION` file, is embedded as `CLAUDEBOX_VERSION` in `wrapper.sh` (a test asserts the two match), and is stamped into the image at build time (`Dockerfile` `ARG`/`ENV`/`LABEL org.claudebox.version`, passed by `make`/`install.sh`). **Bump it whenever you change the host↔container IPC contract** — sidecar filenames/formats, forwarded env, `/out`, secrets injection — so `claudebox checkversion` (host wrapper vs the project's image label) can warn on drift. Bumping `VERSION` without `wrapper.sh` (or vice versa) fails the sync test. On every bump: add a `CHANGELOG.md` entry and tag the commit `git tag -a vX.Y.Z`. Full release/SDLC process — semver rules, release steps, changelog policy — lives in **[docs/versioning.md](docs/versioning.md)**.
- **Secrets are file-based, never CLI.** Credentials enter a project only through the gitignored, chmod-600 `.claudebox/secrets.env` (host source of truth) → per-container `-secrets` sidecars → entrypoint `export` (see the sidecar bullet above). **Never add a flag or flow that accepts a secret _value_ as a command-line argument** — it leaks into shell history, `ps`, and logs. `bootstrap`'s `--gh-token` (pulls the host's own `gh auth token`) and `--secrets-file F` are the pattern to follow; `cb_secrets_put` never echoes values. The same rule is baked into the container `CLAUDE.md` template so every claudebot enforces it in the projects it builds.
- **`/home/claude/.claude` is bind-mounted at runtime — Dockerfile-baked files there are SHADOWED.** The wrapper mounts a per-project host dir over `~/.claude`, so anything `COPY`d into `/home/claude/.claude` in the image is invisible in the running container. To ship default `.claude` content (settings.json, plugins, skills, init.d hooks, config), **seed it at runtime from `entrypoint.sh`** into the mounted dir — copy from a template that lives outside the mount (the `/claude/.claude.json` pattern) or write/install it in the entrypoint. Plugins specifically need a runtime `claude plugin marketplace add` + `claude plugin install` (declaring them in `settings.json` alone does not activate them).
- **Bash tests self-register.** Each `tests/test_*.sh` appends its function names to `ALL_TESTS+=(...)` at the bottom; `test.sh` sources them all and runs by function name. Add new tests the same way. Assertions and helpers live in `tests/common.sh`.
- Docs are split per mode under `docs/modes/*.md`; `README.md` and `CHANGELOG.md` are kept current per release. Update the relevant mode doc when changing that mode's flags/behavior.

#!/bin/bash

dbg() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG $(date +%H:%M:%S.%3N)] $*" >&2; }

# CLAUDEBOX_* is canonical; CLAUDE_* still accepted for backwards compat
CLAUDE_CONTAINER_NAME="${CLAUDEBOX_CONTAINER_NAME:-${CLAUDE_CONTAINER_NAME:-}}"
CLAUDE_WORKSPACE="${CLAUDEBOX_WORKSPACE:-${CLAUDE_WORKSPACE:-}}"
CLAUDE_GIT_NAME="${CLAUDEBOX_GIT_NAME:-${CLAUDE_GIT_NAME:-}}"
CLAUDE_GIT_EMAIL="${CLAUDEBOX_GIT_EMAIL:-${CLAUDE_GIT_EMAIL:-}}"
CLAUDE_IMAGE_VARIANT="${CLAUDEBOX_IMAGE_VARIANT:-${CLAUDE_IMAGE_VARIANT:-full}}"

dbg "entrypoint start, args: $*"
dbg "CLAUDEBOX_CONTAINER_NAME=$CLAUDE_CONTAINER_NAME"
dbg "CLAUDEBOX_WORKSPACE=$CLAUDE_WORKSPACE"

# fix docker socket permissions by matching the container's docker group GID to the socket's GID
if [ -S /var/run/docker.sock ]; then
	SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
	CURRENT_DOCKER_GID=$(getent group docker | cut -d: -f3)
	if [ "$SOCKET_GID" != "$CURRENT_DOCKER_GID" ]; then
		dbg "fixing docker socket GID: $CURRENT_DOCKER_GID -> $SOCKET_GID"
		groupmod -g "$SOCKET_GID" docker
	fi
fi
dbg "docker socket done"

# match claude user's UID/GID to the host directory owner (skip if root)
if [ -n "$CLAUDE_WORKSPACE" ] && [ -d "$CLAUDE_WORKSPACE" ]; then
	HOST_UID=$(stat -c '%u' "$CLAUDE_WORKSPACE")
	HOST_GID=$(stat -c '%g' "$CLAUDE_WORKSPACE")
	CURRENT_UID=$(id -u claude)
	CURRENT_GID=$(id -g claude)

	if [ "$HOST_UID" != "0" ] && [ "$HOST_GID" != "0" ]; then
		if [ "$HOST_GID" != "$CURRENT_GID" ]; then
			dbg "fixing GID: $CURRENT_GID -> $HOST_GID"
			groupmod -g "$HOST_GID" claude
		fi
		if [ "$HOST_UID" != "$CURRENT_UID" ]; then
			dbg "fixing UID: $CURRENT_UID -> $HOST_UID"
			usermod -u "$HOST_UID" claude
		fi
		PARALLEL=$(( $(nproc) / 2 ))
		[ "$PARALLEL" -lt 1 ] && PARALLEL=1
		dbg "chown /home/claude (only misowned, $PARALLEL parallel)"
		find /home/claude \( ! -user "$HOST_UID" -o ! -group "$HOST_GID" \) -print0 | xargs -0 -r -P "$PARALLEL" chown claude:claude
		dbg "chown done"
	fi
fi
dbg "uid/gid matching done"

WORKSPACE_DIR="${CLAUDE_WORKSPACE:-/workspace}"

dbg "WORKSPACE_DIR=$WORKSPACE_DIR"

# generate CLAUDE.md template (baked per image variant, reusable across workspaces)
CLAUDE_MD_TEMPLATE="/home/claude/.claude/CLAUDE.md.template"
if [ ! -f "$CLAUDE_MD_TEMPLATE" ]; then
	dbg "generating CLAUDE.md template (variant: ${CLAUDE_IMAGE_VARIANT:-full})"
	{
		cat <<'CLAUDEMD_HEADER'
# Available Tools in This Container

You are running in a Docker container with full sudo access. Here's what you have:

## Pre-installed
- **Node.js LTS** - with npm
- **Docker CE** with Docker Compose
- git, curl, wget, jq
CLAUDEMD_HEADER

		if [ "${CLAUDE_IMAGE_VARIANT:-full}" = "full" ]; then
			cat <<'CLAUDEMD_FULL'

## Languages & Runtimes
- **Go 1.26.1** - /usr/local/go/bin/go
- **Python 3.12.11** (via pyenv) - default python
- **Node.js LTS** - with npm

## Go Tools
- golangci-lint - linter aggregator
- gopls - language server
- dlv - delve debugger
- staticcheck - static analysis
- gomodifytags - struct tag modifier
- impl - interface implementation generator
- gotests - test generator
- gofumpt - stricter gofmt

## Python Tools
- flake8 - linter
- black - formatter
- isort - import sorter
- autoflake - remove unused imports
- pyright - type checker
- mypy - type checker
- vulture - dead code finder
- pytest, pytest-cov - testing
- pipenv, poetry - dependency management
- pyenv - python version management

## Node.js Tools
- eslint, prettier - linting/formatting
- typescript, ts-node - TypeScript
- yarn, pnpm - package managers
- nodemon, pm2 - process management
- create-react-app, @vue/cli, @angular/cli - framework CLIs
- express-generator - Express scaffolding
- newman - Postman CLI
- http-server, serve - static servers
- lighthouse - performance auditing
- @storybook/cli - component development

## Infrastructure & DevOps
- terraform - infrastructure as code
- kubectl - Kubernetes CLI
- helm - Kubernetes package manager
- docker, docker-compose - containerization
- gh - GitHub CLI

## Databases & Data
- sqlite3 - SQLite CLI
- postgresql-client (psql) - PostgreSQL CLI
- mysql-client - MySQL CLI
- redis-tools (redis-cli) - Redis CLI

## Shell & System Tools
- git - version control
- curl, wget, httpie - HTTP clients
- jq - JSON processor
- tree - directory visualization
- fd-find (fdfind) - fast file finder
- ripgrep (rg) - fast grep
- bat - cat with syntax highlighting
- exa - modern ls
- silversearcher-ag (ag) - code search
- shellcheck - shell script linter
- shfmt - shell formatter
- tmux - terminal multiplexer
- htop - process viewer

## C/C++ Tools
- gcc, g++, make, cmake - compilation
- clang-format - code formatter
- valgrind - memory debugging
- gdb - debugger
- strace, ltrace - tracing
CLAUDEMD_FULL
		else
			cat <<'CLAUDEMD_MINIMAL'

## Minimal Image
This is the minimal variant. Only basic tools are pre-installed (git, curl, wget, jq, Node.js, Docker).
You have passwordless sudo access — install whatever you need with apt-get, pip, npm, go install, etc.
CLAUDEMD_MINIMAL
		fi

		cat <<'CLAUDEMD_NOTES'

## Orchestrating & exposing workloads
You run with the Docker socket mounted (docker-out-of-docker) against this project's
own Colima VM. Containers you start are SIBLINGS on that VM — detached ones outlive
your session, and the human can reach them.
- Build workloads as SELF-CONTAINED images (a Dockerfile that COPYs the code in). Do
  NOT `-v`/bind-mount the workspace into a sibling container — the workspace path is
  not visible to the VM daemon, so the mount comes up empty. COPY the code instead.
- Put workloads that talk to each other on the shared `cb-net` network so they reach
  each other by container name (`http://api:8080`); `cb-browser net` prints the name.
- To let the HUMAN reach a workload from their Mac's browser, publish the port and run
  it detached: `docker run -d --restart unless-stopped -p 8080:8080 <image>`. It is
  then reachable at **this project's VM IP** — the collision-free address; tell the
  human to run `claudebox ip` on their Mac to get it, e.g. `http://<vm-ip>:8080`.
  (`http://localhost:8080` also works via colima's port-forward, but it COLLIDES if
  another project publishes the same port — so give them the VM IP, not localhost.)

## Secrets & credentials
NEVER put a secret value on a command line — arguments leak into shell history, `ps`,
process listings, and logs. This is a hard rule for the flows you build here AND for
anything you tell the human to run.
- This project's secrets live in `.claudebox/secrets.env` on the host (gitignored,
  chmod 600, `KEY=VALUE` per line); the harness injects them into you as env on every
  run. Read a credential from its env var — never hardcode, echo, or commit it.
- Need a NEW secret from the human? Ask them to add a line to `.claudebox/secrets.env`
  (or to bootstrap with `--gh-token` / `--secrets-file`) — never ask them to paste it
  as a command argument or inline in a prompt.
- GitHub is pre-wired: if `GH_TOKEN` is set, `gh` and `git push https://…` are already
  authenticated (no `gh auth login`). Pass secrets to sibling workloads through their
  environment (`docker run -e NAME` inheriting from your env, or an env-file) — never
  baked into an image layer.

## Browser testing (self-contained)
To test a web workload you spin up, use the baked-in `cb-browser` helper — it runs
headless Chromium (Playwright) in a sibling container against your workload and
writes artifacts into the workspace. Put workloads on the shared `cb-net` network
so they're reachable by name:
- `docker run -d --name api --network cb-net your/image`
- `cb-browser shot http://api:8080` → `./cb-browser-out/{screenshot.png,page.json}` (page.json has status/title/text/consoleErrors)
- `cb-browser script ./test.cjs` → run your own Playwright script (`require('playwright')`). Your script is
  READ-ONLY at `/work`; write ALL artifacts (screenshots, JSON, logs) to **`/out`** — it maps to
  `./cb-browser-out` in the workspace (also in `$CB_OUT`). cwd is `/out`, so `page.screenshot({path:'shot.png'})`
  lands there. Writing to `/work` or a workspace path fails with `EROFS` — use `/out` instead of dropping the output.
- `cb-browser watch http://api:8080` → headful browser with a noVNC web UI the human watches/drives live at http://<project-vm-ip>:<port>; `cb-browser watch-stop` to stop
- `cb-browser net` → the network name to attach workloads to
This is the standard way to browser-test here; prefer it over ad-hoc setups.
Opt-in extra: if the human ran `claudebox browser-bridge up` on their Mac, the env
var `CLAUDEBOX_HOST_CDP_URL` is set and `cb-browser cdp <url>` drives THEIR real
Chrome via CDP (dedicated debug profile). Only available when they explicitly start
the bridge; don't rely on it — the self-contained A modes above are the default.
Important: in `cdp` mode the browser runs on the MAC, so `<url>` (and any websockets
the app opens) must be reachable **from the Mac** — the project VM's IP or
`localhost:<port>`, NOT a `cb-net` container name like `http://api:8080` (the Mac's
Chrome can't resolve those). For cb-net / in-VM targets, use `shot`/`script` instead.

## Reporting a bug in the claudebox FRAMEWORK
If you hit something that looks like a bug in the harness that runs you — the
wrapper, this entrypoint, the image, or the Colima/Docker networking — as opposed
to a bug in the project you're building, FILE IT with `cb-report-bug`. Don't try to
patch the framework from inside a project, and don't just mention it in passing —
the report is the durable signal that reaches the maintainer.

This also covers a baked helper (`cb-browser`, `cb-report-bug`, the `cb-net`/VM
setup, etc.) behaving surprisingly, being under-documented, or forcing you into a
workaround or a degraded approach — **file it EVEN IF you found a workaround or
worked around the limitation.** A silent workaround means the maintainer never
learns the tool tripped you up, so the friction never gets fixed. If a tool made
you change your plan ("the mount is read-only, so I'll skip screenshots"), that is
exactly the signal worth reporting.
```
cb-report-bug "<short title>" --layer wrapper|entrypoint|image|networking|other <<'EOF'
## What I was doing
## Expected vs actual
## Minimal repro
## Hypothesis
EOF
```
Reports go to a shared host-visible location the maintainer reviews across all
projects. Use it whenever the framework — not your code — is what's misbehaving.

## What survives a rebuild / restart (and what doesn't)
Your **workspace** and your **Claude session** (history, `--continue`, settings,
plugins — everything under `~/.claude`) live on HOST bind-mounts, so they SURVIVE the
container being rebuilt or recreated: you resume right where you left off. The harness
recreates this container when the image is updated (you'll see a "recreating on the
new image" message), and that's safe for your session.
What does NOT survive: anything written to the container's own filesystem OUTSIDE
those mounts — packages you `apt install` / `npm i -g` at runtime, and scratch files
outside the workspace and `~/.claude`. After a rebuild/recreate they're gone.
- Make setup durable: put it in `~/.claude/init.d/<name>.sh` (runs on container
  create, lives in the mount) instead of running it ad-hoc — it re-applies next time.
- If a tool you keep needing isn't in the image, that's framework feedback: file it
  with `cb-report-bug` so it gets baked in, rather than reinstalling every session.

## Notes
- You have passwordless sudo access
- Docker socket may be mounted for docker-in-docker. The workspace is mounted at the exact same path as on the host, so when running docker commands with volume mounts, use the workspace path as the base (e.g. -v "$PWD/data:/data" will resolve correctly on the host)
- claude CLI at ~/.claude (native install, can self-update)
- Convenience commands are named `cb-*` (on PATH). Run **`cb-help`** to list them with
  one-line summaries (e.g. `cb-browser`, `cb-report-bug`). Baked ones live in
  /usr/local/bin; you can add your own as `~/.claude/bin/cb-<name>` (in PATH) — give it a
  `# summary: ...` header line so `cb-help` describes it.
- ~/.claude/bin is in PATH — custom scripts placed here by the user are available to you
- ~/.claude/init.d/*.sh scripts run once on first container create (not on subsequent starts)
- Extra host directories may be mounted via CLAUDEBOX_MOUNT_* env vars — check what's available if you need files outside the workspace

## IMPORTANT
If you need to overwrite or restructure this CLAUDE.md file for your project, FIRST save the container environment notes above to your memory or to a separate file (e.g. ~/.claude/CONTAINER.md) so you don't lose the container-specific information. These notes are auto-generated only on first run and won't be recreated if the file already exists.
CLAUDEMD_NOTES
	} > "$CLAUDE_MD_TEMPLATE"
	chown claude:claude "$CLAUDE_MD_TEMPLATE"
	dbg "CLAUDE.md template created"
fi

# generate system hint (appended to every claude invocation via --append-system-prompt)
SYSTEM_HINT_FILE="/home/claude/.claude/system-hint.txt"
if [ ! -f "$SYSTEM_HINT_FILE" ]; then
	cat > "$SYSTEM_HINT_FILE" <<SYSHINT
You are running in a Docker container (${CLAUDE_IMAGE_VARIANT:-full} image) with passwordless sudo access. ~/.claude/bin is in PATH — custom user scripts may be available there. Docker socket may be mounted for docker-in-docker. The workspace path inside the container matches the host path so docker volume mounts from within this container resolve correctly on the host. If a file .claudebox/BRIEF.md exists in your workspace, READ IT FIRST — it is the trusted mission brief stating why this project was created and what to build; keep its "Progress / handoff log" section updated as you work. If you hit a bug in the claudebox FRAMEWORK itself (the wrapper/entrypoint/image/networking that runs you, not your project), file it with the \`cb-report-bug\` command rather than working around it silently. The harness changelog is at ~/CHANGELOG.md — consult it to see what claudebox features and conventions exist and what recently changed (especially if a harness behavior surprises you).
SYSHINT
	chown claude:claude "$SYSTEM_HINT_FILE"
	dbg "system hint created"
fi

# Harness-update awareness: compare the image's baked semver ($CLAUDEBOX_VERSION, set
# as an ENV in the Dockerfile) against the last version THIS project saw. On a change
# (i.e. the image was rebuilt to a new version), set a note that the append-system-
# prompt assembly below injects — so claudebot is told to read the changelog after an
# update, reaching every project regardless of the once-generated hint/template. This
# fires once per bump (the seen-version file is then updated). Unstamped/old images
# ($CLAUDEBOX_VERSION unset) are skipped, so no false notes.
HARNESS_VER_FILE="/home/claude/.claude/.harness-version"
HARNESS_UPDATE_NOTE=""
if [ -n "${CLAUDEBOX_VERSION:-}" ]; then
	_seen=""; [ -f "$HARNESS_VER_FILE" ] && _seen="$(cat "$HARNESS_VER_FILE" 2>/dev/null)"
	if [ -n "$_seen" ] && [ "$_seen" != "$CLAUDEBOX_VERSION" ]; then
		HARNESS_UPDATE_NOTE="NOTE: the claudebox harness was updated from v${_seen} to v${CLAUDEBOX_VERSION} since this project last ran. Read ~/CHANGELOG.md (top entry) for what changed before relying on prior assumptions about how the harness behaves."
		dbg "harness update detected: $_seen -> $CLAUDEBOX_VERSION"
	fi
	printf '%s' "$CLAUDEBOX_VERSION" > "$HARNESS_VER_FILE" 2>/dev/null || true
	chown claude:claude "$HARNESS_VER_FILE" 2>/dev/null || true
fi

# Seed the container-side /claudebox skill: a harness self-report the claudebot can run
# from INSIDE (the host `claudebox` binary isn't in here). Rewritten every start so it
# stays current after an image update (it's shipped content, not user-editable).
CB_SKILL_DIR="/home/claude/.claude/skills/claudebox"
mkdir -p "$CB_SKILL_DIR"
cat > "$CB_SKILL_DIR/SKILL.md" <<'CBSKILL'
---
name: claudebox
description: Report the claudebox harness you are running inside — its version, what changed (CHANGELOG), the convenience commands available (cb-help), and this project's container environment (workspace, cb-net, exposing workloads). Use when asked about the claudebox harness/version, available cb-* tools, or the container environment. (You are INSIDE the container — the host `claudebox` CLI is not available here.)
---

# claudebox — harness self-report (from inside the container)

You run INSIDE a claudebox container. Give a quick self-report of your harness
environment. Do NOT try to run the host `claudebox` command — it isn't in here.

1. **Version** — print the harness semver you're running: `echo "$CLAUDEBOX_VERSION"`.
   If a "harness was updated" note appeared this session, mention it.
2. **Convenience commands** — run `cb-help` and show the list of available `cb-*` tools.
3. **What changed** — the harness changelog is at `~/CHANGELOG.md` (point the user there;
   summarize the top entry if they ask).
4. **Environment** — your workspace is `$CLAUDEBOX_WORKSPACE` (same path as on the host).
   Sibling workloads go on the `cb-net` docker network and are reachable by container
   name; publish ports and address them by the VM IP (the human runs `claudebox ip` on
   their Mac). The full orchestration standard is in this project's `CLAUDE.md`.

Keep it a concise self-report, not a deep dive.
CBSKILL
chown -R claude:claude "$CB_SKILL_DIR" 2>/dev/null || true
dbg "seeded container /claudebox skill"

# copy template to workspace if CLAUDE.md doesn't exist there
if [ ! -f "$WORKSPACE_DIR/CLAUDE.md" ]; then
	cp "$CLAUDE_MD_TEMPLATE" "$WORKSPACE_DIR/CLAUDE.md"
	chown claude:claude "$WORKSPACE_DIR/CLAUDE.md"
	dbg "CLAUDE.md copied to $WORKSPACE_DIR"
fi

# If this project was bootstrapped (docs/design/bootstrap.md), surface its mission
# brief unmissably: prepend a one-block banner to the workspace CLAUDE.md pointing at
# .claudebox/BRIEF.md. Guarded by a marker so it's done exactly once (idempotent
# across restarts). We do NOT inline the brief — claudebot reads the live file.
BRIEF_FILE="$WORKSPACE_DIR/.claudebox/BRIEF.md"
if [ -f "$BRIEF_FILE" ] && [ -f "$WORKSPACE_DIR/CLAUDE.md" ] \
   && ! grep -q "claudebox:mission-banner" "$WORKSPACE_DIR/CLAUDE.md" 2>/dev/null; then
	BANNER_TMP="$(mktemp)"
	{
		echo "<!-- claudebox:mission-banner -->"
		echo "## 🎯 Your mission — read \`.claudebox/BRIEF.md\` FIRST"
		echo ""
		echo "This project was bootstrapped with a mission brief at \`.claudebox/BRIEF.md\`."
		echo "It states WHY this project exists and what to build. Read it before anything"
		echo "else, follow it as project spec, and keep its \"Progress / handoff log\""
		echo "section updated as you work."
		echo ""
		echo "---"
		echo ""
		cat "$WORKSPACE_DIR/CLAUDE.md"
	} > "$BANNER_TMP" && mv "$BANNER_TMP" "$WORKSPACE_DIR/CLAUDE.md"
	chown claude:claude "$WORKSPACE_DIR/CLAUDE.md"
	dbg "mission banner prepended (BRIEF.md present)"
fi

# ensure .claude.json has required native install properties
# this helps users who mount their existing .claude directory
CLAUDE_CONFIG_DIR="/home/claude/.claude"
CLAUDE_JSON="$CLAUDE_CONFIG_DIR/.claude.json"

mkdir -p "$CLAUDE_CONFIG_DIR"

dbg "configuring .claude.json"
if [ -f "$CLAUDE_JSON" ]; then
	UPDATED=$(jq '.installMethod = "native" | .autoUpdates = false | .autoUpdatesProtectedForNative = true' "$CLAUDE_JSON") && \
		printf '%s\n' "$UPDATED" > "$CLAUDE_JSON"
else
	cp /claude/.claude.json "$CLAUDE_JSON"
fi

UPDATED=$(jq --arg dir "$WORKSPACE_DIR" '.projects[$dir].hasTrustDialogAccepted = true' "$CLAUDE_JSON") && \
	printf '%s\n' "$UPDATED" > "$CLAUDE_JSON"
chown -R claude:claude "$CLAUDE_CONFIG_DIR"
dbg ".claude.json done"

# run init scripts on first container create (marker lives in container filesystem, not on mount)
INIT_MARKER="/var/run/claude-initialized"
if [ ! -f "$INIT_MARKER" ]; then
	INIT_DIR="/home/claude/.claude/init.d"
	if [ -d "$INIT_DIR" ]; then
		dbg "first run: executing init scripts from $INIT_DIR"
		for script in "$INIT_DIR"/*.sh; do
			[ ! -f "$script" ] && continue
			dbg "init: running $script"
			bash "$script"
			dbg "init: $script exited with $?"
		done
	fi
	touch "$INIT_MARKER"
	dbg "init marker created"
fi

# mode env vars — CLAUDEBOX_MODE_* canonical, CLAUDE_MODE_* legacy fallback
_mode_api="${CLAUDEBOX_MODE_API:-${CLAUDE_MODE_API:-}}"
_mode_api_port="${CLAUDEBOX_MODE_API_PORT:-${CLAUDE_MODE_API_PORT:-8080}}"
_mode_telegram="${CLAUDEBOX_MODE_TELEGRAM:-${CLAUDE_MODE_TELEGRAM:-}}"
_mode_cron="${CLAUDEBOX_MODE_CRON:-${CLAUDE_MODE_CRON:-}}"
_mode_cron_file="${CLAUDEBOX_MODE_CRON_FILE:-${CLAUDE_MODE_CRON_FILE:-}}"

# combined telegram + cron mode — run both; cron in background, telegram bot in foreground
if [ "$_mode_telegram" = "1" ] && [ "$_mode_cron" = "1" ]; then
	dbg "mode: telegram + cron (combined)"
	if [ -z "$_mode_cron_file" ]; then
		echo "❌ cron mode enabled but CLAUDEBOX_MODE_CRON_FILE is not set" >&2
		exit 1
	fi
	if [ ! -f "$_mode_cron_file" ]; then
		echo "❌ cron file not found: $_mode_cron_file" >&2
		exit 1
	fi
	mkdir -p /workspaces /home/claude/.claude/cron/history
	chown claude:claude /workspaces
	chown -R claude:claude /home/claude/.claude/cron 2>/dev/null || true
	CLAUDE_UID=$(id -u claude)
	CLAUDE_GID=$(id -g claude)
	# NOTE: use `;` to terminate the exports so they run in the *current* shell.
	# `cmd1 && cmd2 && python3 cron.py &` would bind the entire `&&` chain into
	# a backgrounded subshell — the exports would never reach the foreground
	# telegram_bot.py process, leaving HOME=/root and breaking shared file paths.
	COMBINED_ENV="export HOME=/home/claude"
	COMBINED_ENV="$COMBINED_ENV; export CLAUDE_CONFIG_DIR=/home/claude/.claude"
	COMBINED_ENV="$COMBINED_ENV; export CLAUDEBOX_MODE_CRON_FILE=$(printf '%q' "$_mode_cron_file")"
	COMBINED_ENV="$COMBINED_ENV; export CLAUDEBOX_WORKSPACE=$(printf '%q' "${CLAUDE_WORKSPACE:-/workspace}")"
	COMBINED_ENV="$COMBINED_ENV; export PATH=/home/claude/.claude/bin:/home/claude/.local/bin:\$PATH"
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "$COMBINED_ENV; python3 /home/claude/cron.py & CRON_PID=\$!; trap 'kill \$CRON_PID 2>/dev/null' EXIT INT TERM; python3 /home/claude/telegram_bot.py"
fi

# api mode — run fastapi server instead of claude
if [ "$_mode_api" = "1" ]; then
	dbg "mode: api server (port $_mode_api_port)"
	mkdir -p /workspaces
	chown claude:claude /workspaces
	CLAUDE_UID=$(id -u claude)
	CLAUDE_GID=$(id -g claude)
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "export HOME=/home/claude && export CLAUDE_CONFIG_DIR=/home/claude/.claude && export CLAUDEBOX_MODE_API_PORT=$_mode_api_port && export PATH=/home/claude/.claude/bin:/home/claude/.local/bin:\$PATH && exec python3 /home/claude/api_server.py"
fi

# telegram mode — run telegram bot instead of claude
if [ "$_mode_telegram" = "1" ]; then
	dbg "mode: telegram bot"
	mkdir -p /workspaces
	chown claude:claude /workspaces
	CLAUDE_UID=$(id -u claude)
	CLAUDE_GID=$(id -g claude)
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "export HOME=/home/claude && export CLAUDE_CONFIG_DIR=/home/claude/.claude && export PATH=/home/claude/.claude/bin:/home/claude/.local/bin:\$PATH && exec python3 /home/claude/telegram_bot.py"
fi

# cron mode — run scheduler that fires claude per cron yaml
if [ "$_mode_cron" = "1" ]; then
	dbg "mode: cron (file: $_mode_cron_file)"
	if [ -z "$_mode_cron_file" ]; then
		echo "❌ cron mode enabled but CLAUDEBOX_MODE_CRON_FILE is not set" >&2
		exit 1
	fi
	if [ ! -f "$_mode_cron_file" ]; then
		echo "❌ cron file not found: $_mode_cron_file" >&2
		exit 1
	fi
	CLAUDE_UID=$(id -u claude)
	CLAUDE_GID=$(id -g claude)
	# ensure claude owns the cron history dir
	mkdir -p /home/claude/.claude/cron/history
	chown -R claude:claude /home/claude/.claude/cron 2>/dev/null || true
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "export HOME=/home/claude && export CLAUDE_CONFIG_DIR=/home/claude/.claude && export CLAUDEBOX_MODE_CRON_FILE=$(printf '%q' "$_mode_cron_file") && export CLAUDEBOX_WORKSPACE=$(printf '%q' "${CLAUDE_WORKSPACE:-/workspace}") && export PATH=/home/claude/.claude/bin:/home/claude/.local/bin:\$PATH && exec python3 /home/claude/cron.py"
fi

# build the command to run as claude
CMD="cd \"$WORKSPACE_DIR\""
CMD="$CMD && export HOME=/home/claude"
CMD="$CMD && export CLAUDE_CONFIG_DIR=/home/claude/.claude"
CMD="$CMD && mkdir -p /home/claude/.claude/bin"
CMD="$CMD && export PATH=/home/claude/.claude/bin:\$PATH"

if [ -n "$CLAUDE_GIT_NAME" ]; then
	CMD="$CMD && git config --global user.name $(printf '%q' "$CLAUDE_GIT_NAME")"
fi

if [ -n "$CLAUDE_GIT_EMAIL" ]; then
	CMD="$CMD && git config --global user.email $(printf '%q' "$CLAUDE_GIT_EMAIL")"
fi

# load auth env vars from file (for existing containers that can't get new env vars)
AUTH_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-auth"
dbg "auth file: $AUTH_FILE (exists: $([ -f "$AUTH_FILE" ] && echo yes || echo no))"
if [ -f "$AUTH_FILE" ]; then
	while IFS='=' read -r name value; do
		if [ -n "$value" ]; then
			dbg "auth: loading $name from file"
			CMD="$CMD && export $name=$(printf '%q' "$value")"
		else
			# empty in the sidecar = explicitly cleared (e.g. CLAUDEBOX_NO_API_KEY) — UNSET it
			# so a value baked into this container's env at `docker run` time doesn't linger
			# and override subscription auth.
			dbg "auth: clearing $name (empty in file)"
			CMD="$CMD && unset $name"
		fi
	done < "$AUTH_FILE"
fi

# load machine-local project secrets the same way (see wrapper.sh: .claudebox/secrets.env
# -> this sidecar). Read from the mount, not `docker run -e`, so they survive restarts.
# When GH_TOKEN is present, gh reads it automatically; we also point git-over-https at
# gh so plain `git push https://github.com/...` is authenticated — i.e. claudebot boots
# logged in to GitHub with no interactive `gh auth login`.
SECRETS_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-secrets"
dbg "secrets file: $SECRETS_FILE (exists: $([ -f "$SECRETS_FILE" ] && echo yes || echo no))"
if [ -f "$SECRETS_FILE" ]; then
	while IFS='=' read -r name value; do
		case "$name" in ''|\#*) continue ;; esac
		if [ -n "$value" ]; then
			dbg "secret: loading $name from file"
			CMD="$CMD && export $name=$(printf '%q' "$value")"
		fi
	done < "$SECRETS_FILE"
	# idempotent; guarded so a bad/absent token never blocks startup
	CMD="$CMD && { [ -n \"\${GH_TOKEN:-}\" ] && gh auth setup-git >/dev/null 2>&1 || true; }"
fi

ARGS_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-args"
UPDATE_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-update"

# build combined append-system-prompt: hint + harness-update note + always-skills
COMBINED_APPEND=""
if [ -f "$SYSTEM_HINT_FILE" ]; then
	COMBINED_APPEND=$(cat "$SYSTEM_HINT_FILE")
fi
if [ -n "$HARNESS_UPDATE_NOTE" ]; then
	COMBINED_APPEND="${COMBINED_APPEND:+$COMBINED_APPEND

}$HARNESS_UPDATE_NOTE"
fi
ALWAYS_SKILLS_DIR="/home/claude/.claude/.always-skills"
if [ -d "$ALWAYS_SKILLS_DIR" ]; then
	dbg "scanning always-skills: $ALWAYS_SKILLS_DIR"
	_skill_count=0
	while IFS= read -r -d '' skill_file; do
		skill_content=$(cat "$skill_file")
		if [ -n "$skill_content" ]; then
			skill_block="[Skill file: ${skill_file}]

${skill_content}"
			if [ -n "$COMBINED_APPEND" ]; then
				COMBINED_APPEND="${COMBINED_APPEND}

${skill_block}"
			else
				COMBINED_APPEND="$skill_block"
			fi
			_skill_count=$(( _skill_count + 1 ))
			dbg "always-skill loaded: $skill_file"
		fi
	done < <(find "$ALWAYS_SKILLS_DIR" -name "SKILL.md" -print0 2>/dev/null | sort -z)
	dbg "always-skills total: $_skill_count"
fi
SYSTEM_HINT_FLAG=""
if [ -n "$COMBINED_APPEND" ]; then
	SYSTEM_HINT_FLAG="--append-system-prompt $(printf '%q' "$COMBINED_APPEND")"
fi

# detect --no-continue and --resume in args (affects whether we auto-add --continue)
_skip_auto_continue() {
	for a in "$@"; do
		case "$a" in
			--no-continue|--resume|--resume=*) return 0 ;;
		esac
	done
	return 1
}

# strip --no-continue from args (not a real claude flag)
_strip_no_continue() {
	for a in "$@"; do
		[ "$a" = "--no-continue" ] && continue
		printf '%q ' "$a"
	done
}

# Default plugin (INTERACTIVE sessions only): install the official git commit-commands
# plugin once per project. Declaring it in settings.json does NOT activate it — Claude
# Code must clone the marketplace and register the plugin — so we run the CLI install,
# best-effort and time-bounded. Deliberately skipped for daemon modes (already exec'd
# above), programmatic (-p) and setup-token runs, and when already installed — so it
# never delays a daemon start or an ephemeral/test container, only real human sessions
# where a commit helper is useful. Opt out with CLAUDEBOX_DEFAULT_PLUGINS=0.
_maybe_install_default_plugin() {
	case "${CLAUDEBOX_DEFAULT_PLUGINS:-1}" in 0|false) return 0 ;; esac
	[ "${1:-}" = "setup-token" ] && return 0
	[ -f "$ARGS_FILE" ] && return 0                       # programmatic (subsequent) run
	local a; for a in "$@"; do case "$a" in -p|--print) return 0 ;; esac; done
	# One-shot marker (on the per-project mount) — set after a SUCCESSFUL install so we
	# never reinstall: a user who later `plugin uninstall`s it isn't fought. On failure
	# (e.g. offline) the marker isn't set, so a later interactive session retries.
	local marker="$CLAUDE_CONFIG_DIR/.claudebox-default-plugins"
	[ -f "$marker" ] && return 0
	dbg "installing default plugin commit-commands (first interactive run)…"
	# Two steps: register the marketplace (clones it), then install the plugin by
	# name@marketplace. `plugin install` alone fails ("not found in marketplace") if
	# the marketplace was never added.
	if timeout 90 setpriv --reuid="$(id -u claude)" --regid="$(id -g claude)" --init-groups \
		bash -c 'export HOME=/home/claude CLAUDE_CONFIG_DIR=/home/claude/.claude PATH=/home/claude/.local/bin:$PATH; claude plugin marketplace add anthropics/claude-plugins-official && exec claude plugin install commit-commands@claude-plugins-official --scope user' \
		>/dev/null 2>&1
	then
		touch "$marker"; chown claude:claude "$marker" 2>/dev/null || true
		dbg "default plugin installed"
	else
		echo "note: default plugin (commit-commands) not installed (offline?) — set CLAUDEBOX_DEFAULT_PLUGINS=0 to silence" >&2
	fi
}
_maybe_install_default_plugin "$@"

# Install the project's enabled profiles (wrapper writes the list to ~/.claude/.profiles
# from the .claudebox config `profiles:` field). Each is a baked installer at
# /usr/local/lib/claudebox/profiles/<name>.sh; run once per profile, marker set only on
# success (so an offline failure retries next start), as the `claude` user, best-effort.
# See docs/design/profiles.md.
_install_profiles() {
	[ "${1:-}" = "setup-token" ] && return 0
	local pf="$CLAUDE_CONFIG_DIR/.profiles" lib="/usr/local/lib/claudebox/profiles" prof marker
	[ -f "$pf" ] || return 0
	for prof in $(cat "$pf" 2>/dev/null); do
		case "$prof" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
		marker="$CLAUDE_CONFIG_DIR/.profile-$prof"
		[ -f "$marker" ] && continue
		if [ ! -x "$lib/$prof.sh" ]; then echo "claudebox: unknown profile '$prof' (no $lib/$prof.sh)" >&2; continue; fi
		dbg "installing profile: $prof"
		if timeout 120 setpriv --reuid="$(id -u claude)" --regid="$(id -g claude)" --init-groups \
			bash -c "export HOME=/home/claude CLAUDE_CONFIG_DIR=/home/claude/.claude PATH=/home/claude/.local/bin:/home/claude/.claude/bin:\$PATH; exec '$lib/$prof.sh'" \
			>/dev/null 2>&1
		then
			touch "$marker"; chown claude:claude "$marker" 2>/dev/null || true
			echo "claudebox: enabled profile '$prof'" >&2
		else
			echo "claudebox: profile '$prof' install failed (offline?) — retries next start" >&2
		fi
	done
}
_install_profiles "$@"

if [ "${1:-}" = "setup-token" ]; then
	dbg "mode: setup-token"
	CMD="$CMD && exec claude setup-token"
elif [ -f "$ARGS_FILE" ]; then
	# args file takes priority (subsequent runs on _prog container via docker start)
	ESCAPED_ARGS=$(cat "$ARGS_FILE")
	rm -f "$ARGS_FILE"
	dbg "mode: programmatic (subsequent), args: $ESCAPED_ARGS"
	# check if --no-continue or --resume is in the escaped args
	if echo "$ESCAPED_ARGS" | grep -qE '\-\-no-continue|\-\-resume'; then
		ESCAPED_ARGS="${ESCAPED_ARGS//--no-continue/}"
		CMD="$CMD && exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG $ESCAPED_ARGS"
	else
		CMD="$CMD && exec claude --dangerously-skip-permissions --continue $SYSTEM_HINT_FLAG $ESCAPED_ARGS"
	fi
elif [ $# -gt 0 ]; then
	if _skip_auto_continue "$@"; then
		ESCAPED_ARGS=$(_strip_no_continue "$@")
		dbg "mode: programmatic (first run, no auto-continue), args: $ESCAPED_ARGS"
		CMD="$CMD && exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG $ESCAPED_ARGS"
	else
		ESCAPED_ARGS=$(printf '%q ' "$@")
		dbg "mode: programmatic (first run), args: $ESCAPED_ARGS"
		CMD="$CMD && (claude --dangerously-skip-permissions --continue $SYSTEM_HINT_FLAG $ESCAPED_ARGS || exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG $ESCAPED_ARGS)"
	fi
else
	dbg "mode: interactive"
	if [ -f "$UPDATE_FILE" ]; then
		rm -f "$UPDATE_FILE"
		dbg "running claude update"
		CMD="$CMD && claude update"
	fi
	NO_CONTINUE_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-no-continue"
	if [ -f "$NO_CONTINUE_FILE" ]; then
		rm -f "$NO_CONTINUE_FILE"
		dbg "no-continue flag set, skipping --continue"
		CMD="$CMD && exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG"
	else
		CMD="$CMD && (claude --dangerously-skip-permissions --continue $SYSTEM_HINT_FLAG || exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG)"
	fi
fi


CLAUDE_UID=$(id -u claude)
CLAUDE_GID=$(id -g claude)
dbg "exec: setpriv --reuid=$CLAUDE_UID --regid=$CLAUDE_GID --init-groups bash -c \"...\""
dbg "CMD: $CMD"
exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups bash -c "$CMD"

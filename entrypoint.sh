#!/bin/bash

dbg() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG $(date +%H:%M:%S.%3N)] $*" >&2; }

# DRIDOCK_* is the only tier (5.0.0). Upstream CLAUDE_CODE_* / CLAUDE_CONFIG_DIR are unrelated.
CLAUDE_CONTAINER_NAME="${DRIDOCK_CONTAINER_NAME:-}"
CLAUDE_WORKSPACE="${DRIDOCK_WORKSPACE:-}"
CLAUDE_GIT_NAME="${DRIDOCK_GIT_NAME:-}"
CLAUDE_GIT_EMAIL="${DRIDOCK_GIT_EMAIL:-}"
CLAUDE_IMAGE_VARIANT="${DRIDOCK_IMAGE_VARIANT:-full}"

dbg "entrypoint start, args: $*"

# ─── DNS self-repair (#72) ───────────────────────────────────────────────────
# Colima writes the VM's /etc/resolv.conf, docker copies it into every container
# at CREATE time, and in `--network-address` VMs the generated value has been
# observed pointing at 192.168.5.4 — which never answers. Result: every
# container in that VM has dead name resolution while ROUTING IS PERFECTLY FINE
# (verified: `curl --resolve` to the same host returns 200). That combination is
# maximally misleading — Claude Code reports a timeout, which reads as an API
# outage or an auth failure, and an hour goes into the wrong hypothesis.
#
# `--network-address` is the normal configuration for projects doing
# container-to-container work, i.e. the mainline of the per-project-VM model.
#
# Repair rather than detect-and-die: we can find a resolver that works, so a
# container that fixes itself and says so beats one that refuses to start.
# Runs before anything that needs the network (daemons, claude, profile
# installers) and is a no-op when DNS already resolves — the common case, and
# it costs one getent.
#
# Probing is write-and-test because the minimal image has no dig/nslookup/host
# (checked). getent honours resolv.conf, so the only way to ask "does THIS
# server answer" is to point at it and try. The original file is restored if no
# candidate works — never leave it worse than we found it.
#
# Deliberately NOT falling back to public resolvers (8.8.8.8 etc.): that moves a
# project's DNS traffic off its own network, which is a policy decision the
# harness shouldn't make silently. If no local candidate answers we say so and
# let a human choose.
_dns_probe_host="${DRIDOCK_DNS_PROBE_HOST:-api.anthropic.com}"

_dns_resolves() { getent hosts "$_dns_probe_host" >/dev/null 2>&1; }

# /proc/net/route stores the gateway as little-endian hex: 0205A8C0 -> 192.168.5.2
_hex_le_to_ip() {
	local h="$1"
	[ "${#h}" = 8 ] || return 1
	printf '%d.%d.%d.%d\n' "0x${h:6:2}" "0x${h:4:2}" "0x${h:2:2}" "0x${h:0:2}"
}

_repair_dns() {
	local backup cand ip ok=0
	backup="$(cat /etc/resolv.conf 2>/dev/null)"

	# Candidates, most-principled first: the actual default gateway(s) from the
	# route table, then the values colima uses in practice. Gateways come first
	# because they're derived from THIS container's networking rather than
	# guessed — 192.168.64.1 (the vmnet gateway) is what answered on the VM that
	# exposed this bug.
	local -a cands=()
	while read -r hexgw; do
		ip="$(_hex_le_to_ip "$hexgw" 2>/dev/null)" && [ -n "$ip" ] && cands+=("$ip")
	done < <(awk '$2=="00000000" && $3!="00000000" {print $3}' /proc/net/route 2>/dev/null)
	cands+=("192.168.5.1" "192.168.5.2")

	for cand in "${cands[@]}"; do
		printf 'nameserver %s\n' "$cand" > /etc/resolv.conf 2>/dev/null || continue
		if _dns_resolves; then
			echo "dridock: DNS was unreachable; repaired /etc/resolv.conf -> nameserver $cand (#72)" >&2
			ok=1
			break
		fi
	done

	if [ "$ok" != 1 ]; then
		# Restore rather than leave a container pointed at the last thing we tried.
		printf '%s\n' "$backup" > /etc/resolv.conf 2>/dev/null || true
		echo "dridock: DNS is unreachable and no local resolver answered (tried: ${cands[*]})." >&2
		echo "  Name resolution will fail inside this container. Routing may still be fine —" >&2
		echo "  test with: curl --resolve <host>:443:<ip> https://<host>/" >&2
		echo "  See #72. Original /etc/resolv.conf left untouched." >&2
	fi
}

if [ "$(id -u)" = 0 ]; then
	if _dns_resolves; then
		dbg "dns: $_dns_probe_host resolves — no repair needed"
	else
		_repair_dns
	fi
fi
dbg "DRIDOCK_CONTAINER_NAME=$CLAUDE_CONTAINER_NAME"
dbg "DRIDOCK_WORKSPACE=$CLAUDE_WORKSPACE"

# fix docker socket permissions by matching the container's docker group GID to the socket's GID
if [ -S /var/run/docker.sock ]; then
	SOCKET_GID=$(stat -c '%g' /var/run/docker.sock)
	CURRENT_DOCKER_GID=$(getent group docker | cut -d: -f3)
	if [ "$SOCKET_GID" != "$CURRENT_DOCKER_GID" ]; then
		dbg "fixing docker socket GID: $CURRENT_DOCKER_GID -> $SOCKET_GID"
		# #37 Tier 1 #9 — surface groupmod failure. Silent failure means the
		# in-container docker group GID doesn't match the socket's, so `docker`
		# calls fail with permission errors later — hard to diagnose without
		# a trace here.
		groupmod -g "$SOCKET_GID" docker \
			|| echo "dridock: groupmod -g $SOCKET_GID docker FAILED — docker socket access likely broken" >&2
	fi
fi
dbg "docker socket done"

# Opt-in: prune docker build cache AND dangling (untagged, unreferenced) images on every start,
# to keep the shared VM disk from creeping up on image-iterating projects (build cache is the real
# accumulator; dangling images pile up when a rebuild retags an existing tag and orphans the old
# one — common on harness-dev projects that `make build` often; see disk-management.md). Safe +
# best-effort: `image prune -f` only touches untagged unreferenced images (never a tagged image
# and never a running container's image), and both never block startup. Default off.
case "${DRIDOCK_PRUNE_ON_START:-}" in
	1|true|yes|on)
		if [ -S /var/run/docker.sock ]; then
			dbg "prune-on-start: docker builder prune -f + docker image prune -f"
			docker builder prune -f >/dev/null 2>&1 || true
			docker image prune -f   >/dev/null 2>&1 || true
		fi ;;
esac

# match claude user's UID/GID to the host directory owner (skip if root)
if [ -n "$CLAUDE_WORKSPACE" ] && [ -d "$CLAUDE_WORKSPACE" ]; then
	HOST_UID=$(stat -c '%u' "$CLAUDE_WORKSPACE")
	HOST_GID=$(stat -c '%g' "$CLAUDE_WORKSPACE")
	CURRENT_UID=$(id -u claude)
	CURRENT_GID=$(id -g claude)

	if [ "$HOST_UID" != "0" ] && [ "$HOST_GID" != "0" ]; then
		if [ "$HOST_GID" != "$CURRENT_GID" ]; then
			dbg "fixing GID: $CURRENT_GID -> $HOST_GID"
			# #37 Tier 1 #9 — surface UID/GID remap failures. If the target
			# GID is in use, groupmod fails silently and the later
			# `chown claude:claude` stamps files with the UNCHANGED gid →
			# host files misowned when the container exits, invisible to
			# the user until they hit a permission error on their Mac.
			groupmod -g "$HOST_GID" claude \
				|| echo "dridock: groupmod -g $HOST_GID claude FAILED — host files may end up misowned" >&2
		fi
		if [ "$HOST_UID" != "$CURRENT_UID" ]; then
			dbg "fixing UID: $CURRENT_UID -> $HOST_UID"
			usermod -u "$HOST_UID" claude \
				|| echo "dridock: usermod -u $HOST_UID claude FAILED — host files may end up misowned" >&2
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

# Framework guidance -> USER MEMORY (~/.claude/CLAUDE.md), rewritten EVERY container start
# from the baked image. Claude Code loads ~/.claude/CLAUDE.md as user memory ADDITIVELY with
# (and at lower precedence than) the project's own ./CLAUDE.md — so this reaches every
# claudebot, INCLUDING existing-repo projects that already have their own CLAUDE.md, and it
# always reflects the current harness (fixes the old once-per-project staleness). We never
# touch the project's ./CLAUDE.md. See docs/design/framework-guidance.md.
# Ensure ~/.claude EXISTS before anything writes into it (#64). The wrapper normally
# bind-mounts a host dir over this path, so it's present for every `dridock` invocation
# — but a container started WITHOUT that mount has no such directory, and every write
# below fails. That's not hypothetical: it's the "spawn an API sibling from a workload"
# pattern (#62) and the DooD goal this fork is built around.
#
# Pre-4.2.2 the directory happened to exist in the image because `claude install --yes`
# ran as the `claude` user in `base` and created it as a side effect. 4.2.2 moved the
# CLI install to a builder stage and COPYs only `.local/` + `.claude.json`, so the
# accident went away and the mountless case started failing (#64).
#
# Fixed here rather than by re-adding it to the Dockerfile: the entrypoint already owns
# runtime seeding of ~/.claude (see the HEADS UP block in the Dockerfile), and doing it
# here holds regardless of image contents or mount state. Re-adding a baked directory
# would restore the same accident this bug came from.
#
# Deliberately NOT `|| true` — if we cannot create the config dir, the CLAUDE.md and
# system-hint injection below silently does nothing and the claudebot runs without its
# framework guidance. Say so loudly instead of degrading in silence.
if ! mkdir -p /home/claude/.claude; then
	echo "dridock: FAILED to create /home/claude/.claude — framework guidance (CLAUDE.md, system-hint) will NOT be injected" >&2
fi
chown claude:claude /home/claude/.claude 2>/dev/null \
	|| echo "dridock: chown /home/claude/.claude FAILED — claude user may be unable to write its own config" >&2

CLAUDE_MD_USER="/home/claude/.claude/CLAUDE.md"
dbg "writing framework guidance to user memory (variant: ${CLAUDE_IMAGE_VARIANT:-full})"
{
		cat <<'CLAUDEMD_HEADER'
# dridock — framework guidance (auto-generated; do not edit)

> This is dridock **framework** guidance, loaded as *user memory* and **rewritten on every
> container start** — edits here are lost next boot. It describes the container/environment you
> run in. Your project's own `./CLAUDE.md` (if it has one) is loaded alongside this and is
> authoritative for project-specific conventions — put project notes there, not here.

# Available Tools in This Container

You are running in a Docker container with full sudo access. Here's what you have:

## Pre-installed
- **Node.js LTS** - with npm
- **Docker CE** with Docker Compose
- git, curl, wget, jq
CLAUDEMD_HEADER

		if [ "${CLAUDE_IMAGE_VARIANT:-full}" = "full" ]; then
			cat <<'CLAUDEMD_FULL'

## What's baked (full image)
- **Languages:** Go 1.26.1 · Python 3.12.11 (pyenv) · Node.js LTS (npm/yarn/pnpm).
- **Language servers** (for the `*-lsp` plugins): `gopls`, `typescript-language-server`, `pyright`.
- **Linters/formatters:** golangci-lint, gofumpt · black, isort, flake8, mypy · eslint, prettier · shellcheck, shfmt · clang-format.
- **Build/DevOps:** gcc/g++/make/cmake, gdb, valgrind · docker + docker-compose · terraform, kubectl, helm · gh.
- **DB clients:** psql, mysql, sqlite3, redis-cli.  **Search/shell:** ripgrep (`rg`), fd (`fdfind`), jq, bat, tree, tmux, httpie, curl/wget.

You have passwordless sudo — install anything else with `apt-get`/`pip`/`npm`/`go install`. But
for a tool you keep needing, `cb-report-bug` it so it gets baked in (or add it via a profile /
`~/.claude/init.d`), rather than reinstalling every session. Discover what's present with
`which <tool>` / `apt list --installed` / `pip list`; heavy/niche language servers install per
**profile** (`.dridock/config.yml` `profiles: [...]` — list them with `dridock profiles`).
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
  then reachable at **this project's VM IP**, e.g. `http://<vm-ip>:8080`. That IP is in
  your env as **`$DRIDOCK_VM_IP`** (also `cb-browser ip`) — the container can't
  self-discover it, so use that var; the human gets it with `dridock ip`.
- **The VM IP ROTATES across VM restarts** (e.g. .13 → .16). So NEVER hardcode it in
  project source or config — not in `next.config.ts` `allowedDevOrigins`, Vite
  `server.allowedHosts`, CORS allowlists, `.env`, or a test's base URL. Read
  `$DRIDOCK_VM_IP` fresh each run and feed it in (or configure the framework to accept
  any host in dev). A stale baked IP is a top cause of "worked yesterday, 403/blocked
  today". `$DRIDOCK_VM_IP` self-heals: the harness refreshes it every launch.
- `http://localhost:8080` is NOT a reliable substitute: it only works if colima happens
  to be forwarding that exact port to the Mac, and it COLLIDES when two projects publish
  the same port. Always prefer the VM IP.

### N-tier apps: two addressing planes (the dridock standard)
For any multi-tier app (frontend + API + db …) there are TWO address spaces — keep them
straight or you'll chase phantom CORS/connection bugs:
- **Service ↔ service** (API→db, Next SSR→API): runs inside the VM on `cb-net` → address
  by **container name** (`http://api:8080`, `postgres:5432`). Stable.
- **Browser → service** (the human's Chrome / `cb-browser cdp`, on the Mac): reaches a
  workload ONLY at **`http://$DRIDOCK_VM_IP:<port>`** (published port) — never a `cb-net`
  name (Chrome can't resolve it), never `localhost`.
Rules: bind services to **`0.0.0.0`** (not `127.0.0.1`) so they're reachable on both
planes; the browser tier's API base URL must be the VM IP (e.g. `NEXT_PUBLIC_API_BASE=
http://$DRIDOCK_VM_IP:8080`), while server-side code calls the API by container name;
drive **CORS / `allowedDevOrigins`** from `$DRIDOCK_VM_IP` (and `$DRIDOCK_HOSTNAME` if
the human set one via `dridock net`) at server start — do NOT hardcode a rotating IP,
and don't paper over it with wildcard CORS. This is a dridock STANDARD (so every project
does it the same way): the full spec — snippets, a worked Next+API+postgres layout, and a
symptom→cause→fix table — is in `docs/design/n-tier-networking.md` on the host. If it's
still unclear or you think the standard is wrong/incomplete, `cb-consult open` it.

## Disk discipline (avoid the ENOSPC-kills-the-Bash-tool trap)
Your VM has ONE overlay disk shared by docker (images + BuildKit **build cache**) AND your
`/tmp` — where the Bash tool writes `/tmp/claude-501/<id>` for every command. If docker
bloat fills it, the Bash tool can't create its tempdir and **every** command fails with
`ENOSPC` — including `cb-report-bug` / `cb-df`, which are themselves Bash.
- **Watch it:** run **`cb-df`** (or `df -h /` + `docker system df`) before/after builds.
  Prune before `/` hits ~90%.
- **Prune as you iterate, not once at the end:** `docker builder prune -f` (build cache —
  the real accumulator) after EACH `docker compose build`; `docker image prune -af`
  (unused images). Big hammer: `docker system prune -af`.
- **If Bash is ALREADY dead (ENOSPC on every call), don't try to shell out — you can't.**
  Your **Write tool still works**: write a Markdown report file directly into the mounted
  drop dir `/home/claude/framework-bugs/<project-id>-<ts>-<slug>.md` (mirroring what
  `cb-report-bug` produces), then ask the human to reclaim disk on the Mac
  (`docker system prune -af` or `dridock vm gc`). Bash recovers once `/` has room.
- Image-heavy project? The human can raise `vm.disk` in `.dridock/config.yml` (sparse —
  near-zero Mac cost; needs `dridock down` + restart). Full standard:
  `docs/design/disk-management.md` on the host.

## What survives a container restart (and what silently doesn't)

Your container gets **recreated** routinely — a `dridock down && dridock start`, an image
rebuild, a VM restart, a Mac reboot. It is not a long-lived box, and a recreate is not an
error condition. Exactly two locations survive it:

- **Your workspace** — bind-mounted from the Mac at the same path. Project files go here.
- **`~/.claude`** — bind-mounted. Your session history, skills, MCP config, `init.d` hooks,
  cron history, `~/.claude/bin` (on PATH).

**Everything else is discarded**: `/tmp`, `/opt`, anything under `/home/claude` OUTSIDE
`.claude`, and anything you `sudo apt-get install` / `npm install -g` / `pip install` into
the system. No warning is printed when it goes.

The loss is easy to miss because your **conversation survives** — it lives under `.claude`.
So after a recreate you can resume a session that confidently refers to a venv, a scratch
file, or an installed tool that no longer exists.

- Need a file to persist? Put it in the **workspace** (if it belongs to the project) or
  under **`~/.claude`** (if it's yours).
- Need a *tool* to persist? Either install it under `~/.claude`
  (`npm install -g --prefix /home/claude/.claude` puts binaries in `~/.claude/bin`, already
  on PATH), or — better — make it **re-creatable** from a script that lives in the
  workspace, so a fresh container reproduces it instead of remembering it.
- `~/.claude/init.d/*.sh` re-runs on **every** fresh container, so a setup script there is a
  good way to make your environment reproducible — but it MUST be idempotent (see below).

## init.d hooks must be idempotent

`~/.claude/init.d/*.sh` runs once per *container*, not once per project. Its guard lives on
the container filesystem, so a recreate re-runs every hook — potentially in the middle of
work you're partway through, with your conversation intact and no signal that the
environment re-initialized underneath you.

Write hooks that are safe to run repeatedly: check before you append, `mkdir -p` rather than
`mkdir`, `install -m` rather than `cat >>`, and never assume "first run". A hook that
appends a line to a config file will append it again on every recreate.

## Secrets & credentials
NEVER put a secret value on a command line — arguments leak into shell history, `ps`,
process listings, and logs. This is a hard rule for the flows you build here AND for
anything you tell the human to run.
- This project's secrets live in `.dridock/secrets.env` on the host (gitignored,
  chmod 600, `KEY=VALUE` per line); the harness injects them into you as env on every
  run. Read a credential from its env var — never hardcode, echo, or commit it.
- Need a NEW secret from the human? Ask them to add a line to `.dridock/secrets.env`
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
  **A1 only** (in-VM, `cb-net`, headless — no CDP env forwarded). For CDP-driven custom flows against the
  human's real Chrome, use **`cb-browser script-cdp`** (see the CDP gotchas below).
- `cb-browser watch http://api:8080` → headful browser with a noVNC web UI the human watches/drives live at http://<project-vm-ip>:<port>; `cb-browser watch-stop` to stop
- `cb-browser net` → the network name to attach workloads to
This is the standard way to browser-test here; prefer it over ad-hoc setups.
Opt-in extra: if the human ran `dridock browser-bridge up` on their Mac, the env
var `DRIDOCK_HOST_CDP_URL` is set and `cb-browser cdp <url>` drives THEIR real
Chrome via CDP (dedicated debug profile). Only available when they explicitly start
the bridge; don't rely on it — the self-contained A modes above are the default.
CDP gotchas (these waste cycles if you rediscover them each time):
- The browser runs **on the Mac**. `<url>` (and every websocket the page opens) must be
  reachable FROM THE MAC = **`http://$DRIDOCK_VM_IP:<port>`**. NOT `localhost`/
  `127.0.0.1` (that's the Mac's own loopback, not this VM — your app isn't there) and
  NOT a `cb-net` name like `http://api:8080` (Chrome can't resolve it). `cb-browser cdp`
  auto-rewrites a localhost URL to the VM IP for you, but pass the VM IP directly.
- Same VM-IP-rotation rule as above: use `$DRIDOCK_VM_IP` fresh; don't paste a past IP.
- **Writing a custom CDP script? Use `cb-browser script-cdp <file.cjs>`, NOT `cb-browser script`.**
  `script` runs on `cb-net` and does NOT forward `$DRIDOCK_HOST_CDP_URL` — a `connectOverCDP()`
  from there won't reach the bridge. `script-cdp` forwards the URL, uses `--network host`, and
  **closes any page tabs your script opened but didn't `page.close()`** on exit (opt-out:
  `CB_BROWSER_CDP_KEEP=1`). This matters because `browser.close()` alone only detaches the CDP
  connection — the tab is backed by the human's real Chrome process and stays until an explicit
  `page.close()` / `Target.closeTarget`. Running the naïve pattern (`connectOverCDP → newPage →
  browser.close()`) under `script-cdp` still leaks in principle but the wrapper cleans up after you.
- `cb-browser cdp` and `cb-browser script-cdp` are the two supported CDP entry points; both use
  the baked Playwright, and both **auto-warm** the debug Chrome with an `about:blank` scratch
  page when `/json/list` shows zero page targets — Playwright's `connectOverCDP` against a stock
  (non-Playwright) Chrome fails with `Browser.setDownloadBehavior: not supported` when the debug
  Chrome is empty, and the warm-up prevents it. Rolling your OWN `chromium.connectOverCDP(...)`
  doesn't get that warm-up and hits the same failure the moment the debug Chrome empties (which
  happens right after any script that closes all its own tabs). If you must go raw, either
  `PUT $CDP_URL/json/new?about:blank` first, or use a `CDPSession` (`Page.navigate` /
  `Page.captureScreenshot`) instead of the high-level context/page API.
- For cb-net / in-VM-only targets (incl. their websockets), use `shot`/`script` instead —
  those run inside the VM on `cb-net` and reach workloads by container name.

## Framework-vs-project: where does a rule belong?
When you learn something the hard way and go to write it down — as a line in the
project's `CLAUDE.md`, a project doc, a skill file, an `init.d` hook — pause and ask:
**is this a project rule or a framework rule?** Getting this wrong is the single most
common way friction stays local: agent hits a dridock footgun, solves it, writes
"next time do X" into the project's `CLAUDE.md`, and every other claudebot in every
other project keeps re-discovering the same footgun because the note never propagated.
- **The check (one question).** Does the rule name any code, filename, schema, service,
  or concept **that belongs to this project**? If yes → project rule, write it locally.
  If no → it's a framework rule and it does NOT belong in this project.
- **Signals you're on the framework side** (not exhaustive — the check above is
  authoritative): the rule only mentions `cb-*` helpers, `cb-net`, `DRIDOCK_*` env
  vars, the VM IP / rotation, `.dridock/secrets.env`, `~/.claude/init.d`, the browser
  bridge, the Docker socket, sidecar files, or "how any dridock project should…". If
  the rule would read identically in a different project you've never seen — framework.
- **What to do with a framework rule.** Route it to the right channel and stop:
  - Concrete defect / missing warning / under-documented helper → `cb-report-bug`
    (a doc bug is still a bug — file it against the doc that should have warned you).
  - "What's the right pattern?" question with no clear standard yet → `cb-consult open`.
  The point of both channels is that the resolution lands in the baked guidance / a
  `docs/design/*` standard, so **every future claudebot inherits it**. A note in one
  project's `CLAUDE.md` inherits to nobody.
- **When in doubt, escalate.** A false-positive escalation costs the maintainer one
  triage; a false-negative (framework rule silently written to a project) is invisible
  and permanent. Prefer the visible cost.

## Reporting a bug in the dridock FRAMEWORK
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

## Escalating a framework BEST-PRACTICE question (cb-consult)
Distinct from a bug: sometimes you're stuck on *how a dridock project SHOULD do
something* and the answer ought to be a dridock standard, not a per-project
reinvention. Open a **consult** — a supervised conversation with framework-Claude (the
Claude working on the harness itself) that the human approves. Open one ONLY when ALL
hold: (a) the problem is about the harness/ENVIRONMENT — networking, the VM, the image,
the `cb-*` tooling — not your app's own logic; (b) it would recur in ANY dridock
project (a general engineering concern); (c) it isn't already answered by this guidance.
The archetype: N-tier networking (how tiers address each other vs how the browser reaches
them, the rotating VM IP, CORS/allowed-origins). If it's a concrete DEFECT rather than a
"what's the right pattern" question, use `cb-report-bug` instead.
```
cb-consult open "<short title>" --layer networking <<'EOF'
## Problem            (what you're stuck on)
## Why it's general   (why any dridock N-tier project hits this)
## What I tried       (and why it didn't hold — e.g. hardcoded IP broke on rotation)
EOF
```
The reply comes back **async** after the human approves it. To be alerted the moment it
lands instead of polling, **right after you open a consult, launch `cb-consult watch` as a
BACKGROUND task** (it's token-free, blocks until this project's threads change, then exits
and prints what changed — you're re-invoked on exit; relaunch it if you're still waiting).
Only watch while you actually have a consult open — don't run it as a blanket background
poller. If your session ends first, no worry: at your next startup the harness surfaces any
approved reply waiting for you. Otherwise just re-check with `cb-consult read <id>`. When
you get the reply, ADOPT it and `cb-consult resolve <id>` (or `cb-consult say <id>` if you
disagree with the standard). The resolution usually also updates this baked guidance, so it
becomes the standard every future claudebot inherits — which is the whole point. See the
`cb-consult` help for the full verb set (open/say/read/list/watch/resolve).

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
- The same surface is available as **`dridock <verb>`** — a baked shim aliases
  `dridock consult|report-bug|browser|df` to their `cb-*` implementations, and
  prints a targeted "run this on your Mac" message for host-only verbs
  (start/stop/vm/ip/net/bootstrap/…). `dridock help` in-container shows both sides;
  `cb-*` remains canonical. Type whichever feels natural.
- ~/.claude/bin is in PATH — custom scripts placed here by the user are available to you
- ~/.claude/init.d/*.sh scripts run once on first container create (not on subsequent starts)
- Extra host directories may be mounted via DRIDOCK_MOUNT_* env vars — check what's available if you need files outside the workspace
- Every dridock setting is read as `DRIDOCK_X` and **only** `DRIDOCK_X`. The legacy `CLAUDEBOX_*` / `CLAUDE_*` tiers, and the boot-time aliaser that mirrored them, were removed in 5.0.0 — setting a `CLAUDEBOX_*` name now does nothing at all, silently. If a setting isn't taking effect, check its prefix first. Genuine upstream Claude Code variables (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`) were never part of that rename and are unaffected. See docs/roadmap.md.

## Remember
This file is FRAMEWORK guidance (user memory), not your project's CLAUDE.md — it is rewritten
on every container start, so don't edit it to store anything (it won't survive). If your project
needs its own conventions, put them in the project's own `./CLAUDE.md`, which is loaded alongside
this file and takes precedence for project-specific instructions.
CLAUDEMD_NOTES

	# Bootstrapped project? Surface its mission brief here (this file is always loaded) — check
	# .dridock/BRIEF.md (3.0+) first, fall back to legacy .claudebox/BRIEF.md.
	_BRIEF_DOTNAME=""
	if [ -f "$WORKSPACE_DIR/.dridock/BRIEF.md" ]; then _BRIEF_DOTNAME=".dridock"
	elif [ -f "$WORKSPACE_DIR/.claudebox/BRIEF.md" ]; then _BRIEF_DOTNAME=".claudebox"; fi
	if [ -n "$_BRIEF_DOTNAME" ]; then
		cat <<CLAUDEMD_BRIEF

## 🎯 Your mission — read \`${_BRIEF_DOTNAME}/BRIEF.md\` FIRST
This project was bootstrapped with a mission brief at \`${_BRIEF_DOTNAME}/BRIEF.md\`. It states WHY this
project exists and what to build. Read it before anything else, follow it as the project spec,
and keep its "Progress / handoff log" section updated as you work.
CLAUDEMD_BRIEF
	fi
} > "$CLAUDE_MD_USER"
chown claude:claude "$CLAUDE_MD_USER"
dbg "framework guidance written to $CLAUDE_MD_USER"

# generate system hint (appended to every claude invocation via --append-system-prompt)
SYSTEM_HINT_FILE="/home/claude/.claude/system-hint.txt"
if [ ! -f "$SYSTEM_HINT_FILE" ]; then
	cat > "$SYSTEM_HINT_FILE" <<SYSHINT
You are running in a Docker container (${CLAUDE_IMAGE_VARIANT:-full} image) with passwordless sudo access. ~/.claude/bin is in PATH — custom user scripts may be available there. ONLY your workspace and ~/.claude survive a container recreate (which is routine); /tmp and anything apt/npm/pip-installed into the system are discarded silently, as is anything YOU write under /opt (the harness content baked there is restored from the image, your additions are not) — see \"What survives a container restart\" in your CLAUDE.md. Docker socket may be mounted for docker-in-docker. The workspace path inside the container matches the host path so docker volume mounts from within this container resolve correctly on the host. If a file .dridock/BRIEF.md (or legacy .claudebox/BRIEF.md) exists in your workspace, READ IT FIRST — it is the trusted mission brief stating why this project was created and what to build; keep its "Progress / handoff log" section updated as you work. If you hit a bug in the dridock FRAMEWORK itself (the wrapper/entrypoint/image/networking that runs you, not your project), file it with the \`cb-report-bug\` command rather than working around it silently. The harness changelog is at /opt/dridock/CHANGELOG.md — consult it to see what dridock features and conventions exist and what recently changed (especially if a harness behavior surprises you).
SYSHINT
	chown claude:claude "$SYSTEM_HINT_FILE"
	dbg "system hint created"
fi

# Harness-update awareness: compare the image's baked semver ($DRIDOCK_VERSION, set
# as an ENV in the Dockerfile) against the last version THIS project saw. On a change
# (i.e. the image was rebuilt to a new version), set a note that the append-system-
# prompt assembly below injects — so claudebot is told to read the changelog after an
# update, reaching every project regardless of the once-generated hint/template. This
# fires once per bump (the seen-version file is then updated). Unstamped/old images
# ($DRIDOCK_VERSION unset) are skipped, so no false notes.
HARNESS_VER_FILE="/home/claude/.claude/.harness-version"
HARNESS_UPDATE_NOTE=""
if [ -n "${DRIDOCK_VERSION:-}" ]; then
	_seen=""; [ -f "$HARNESS_VER_FILE" ] && _seen="$(cat "$HARNESS_VER_FILE" 2>/dev/null)"
	if [ -n "$_seen" ] && [ "$_seen" != "$DRIDOCK_VERSION" ]; then
		HARNESS_UPDATE_NOTE="NOTE: the dridock harness was updated from v${_seen} to v${DRIDOCK_VERSION} since this project last ran. Read /opt/dridock/CHANGELOG.md (top entry) for what changed before relying on prior assumptions about how the harness behaves."
		dbg "harness update detected: $_seen -> $DRIDOCK_VERSION"
	fi
	printf '%s' "$DRIDOCK_VERSION" > "$HARNESS_VER_FILE" 2>/dev/null || true
	chown claude:claude "$HARNESS_VER_FILE" 2>/dev/null || true
fi

# (A) Consult surfacing — if a framework-consult reply is waiting for THIS project
# (status awaiting-claudebot), tell the claudebot at startup so it doesn't sit unaware of
# an approved answer. Mirrors the host wrapper surfacing consults to the human. Only
# threads for this project id, only the actionable state.
CONSULT_NOTE=""
_cdir="${DRIDOCK_CONSULT_DIR:-/home/claude/framework-consult}"
if [ -d "$_cdir" ] && [ -n "${DRIDOCK_PROJECT_ID:-}" ]; then
	_cn=0; _cids=""
	for _ctd in "$_cdir"/*/; do
		[ -d "$_ctd" ] || continue; _ctd="${_ctd%/}"; _cm="$_ctd/meta"
		[ -f "$_cm" ] || continue
		[ "$(sed -n 's/^project=//p' "$_cm" | head -1)" = "$DRIDOCK_PROJECT_ID" ] || continue
		[ "$(sed -n 's/^status=//p' "$_cm" | tail -1)" = "awaiting-claudebot" ] || continue
		_cn=$((_cn + 1)); _cids="${_cids:+$_cids, }$(basename "$_ctd")"
	done
	if [ "$_cn" -gt 0 ]; then
		CONSULT_NOTE="NOTE: ${_cn} framework consult(s) have an APPROVED reply waiting for you (${_cids}). Run \`cb-consult read <id>\`, adopt the resolution, and \`cb-consult resolve <id>\` — or \`cb-consult say <id>\` if you disagree with the framework standard. See the 'Escalating a framework BEST-PRACTICE question' section for how consults work."
		dbg "consult surfacing: $_cn awaiting-claudebot for $DRIDOCK_PROJECT_ID"
	fi
fi

# (A2) Framework-Claude surfacing — if THIS claudebot is developing the harness itself
# (workspace fingerprint = a `dridock-ts/src/domain/dridockVersion.ts` file at the
# workspace root — unique to this repo, replaces the pre-4.0.0 `wrapper.sh` + grep
# check that broke when wrapper.sh was deleted), OR DRIDOCK_HARNESS_DEV=1 opt-in,
# OR the legacy alias DRIDOCK_FRAMEWORK_DEV=1), also inject a note listing cross-
# project consults awaiting a framework draft AND framework-bug reports not yet
# marked reviewed. This is the review flow the host `dridock consult list` /
# `dridock framework-bugs list` surfaces to a human on the Mac — mirrored here so
# a framework-dev claudebot working from INSIDE a container catches waiting work
# at startup instead of missing it (there is no host wrapper in here). Skipped
# for every normal claudebot.
FRAMEWORK_NOTE=""
_is_fwdev=0
case "${DRIDOCK_HARNESS_DEV:-${DRIDOCK_FRAMEWORK_DEV:-}}" in 1|true|yes|on) _is_fwdev=1 ;; esac
if [ "$_is_fwdev" = 0 ] && [ -n "${DRIDOCK_WORKSPACE:-}" ] && [ -f "$DRIDOCK_WORKSPACE/dridock-ts/src/domain/dridockVersion.ts" ]; then
	_is_fwdev=1
fi
if [ "$_is_fwdev" = 1 ]; then
	_fwc_dir="${DRIDOCK_CONSULT_DIR:-/home/claude/framework-consult}"
	_fwb_dir="${DRIDOCK_FRAMEWORK_BUGS_DIR:-/home/claude/framework-bugs}"
	_fwc_n=0; _fwc_ids=""
	if [ -d "$_fwc_dir" ]; then
		for _ctd in "$_fwc_dir"/*/; do
			[ -d "$_ctd" ] || continue; _ctd="${_ctd%/}"; _cm="$_ctd/meta"
			[ -f "$_cm" ] || continue
			[ "$(sed -n 's/^status=//p' "$_cm" | tail -1)" = "awaiting-framework" ] || continue
			_fwc_n=$((_fwc_n + 1))
			_fwc_ids="${_fwc_ids:+$_fwc_ids, }$(basename "$_ctd")"
		done
	fi
	_fwb_n=0; _fwb_slugs=""
	if [ -d "$_fwb_dir" ]; then
		for _bug in "$_fwb_dir"/*.md; do
			[ -f "$_bug" ] || continue
			[ -f "${_bug}.reviewed" ] && continue
			_fwb_n=$((_fwb_n + 1))
			_fwb_slugs="${_fwb_slugs:+$_fwb_slugs, }$(basename "$_bug" .md)"
		done
	fi
	if [ "$_fwc_n" -gt 0 ] || [ "$_fwb_n" -gt 0 ]; then
		FRAMEWORK_NOTE="NOTE (framework-dev):"
		[ "$_fwc_n" -gt 0 ] && FRAMEWORK_NOTE="${FRAMEWORK_NOTE} ${_fwc_n} consult(s) awaiting your framework draft (${_fwc_ids});"
		[ "$_fwb_n" -gt 0 ] && FRAMEWORK_NOTE="${FRAMEWORK_NOTE} ${_fwb_n} unreviewed framework-bug report(s) (${_fwb_slugs});"
		FRAMEWORK_NOTE="${FRAMEWORK_NOTE} review with \`cb-consult list --all\` / \`cb-report-bug list\`. Adopt or reject each; mark bugs handled with \`cb-report-bug done <slug>\`."
		dbg "framework-dev surfacing: $_fwc_n consult(s) awaiting-framework, $_fwb_n unreviewed bug(s)"
	fi
fi

# (Disk) startup MOTD — if the VM's shared overlay is already low at boot, warn the claudebot
# up front (docker images/build cache and the Bash tool's /tmp share ONE disk; a full disk =
# ENOSPC on every Bash call). See docs/design/disk-management.md.
DISK_NOTE=""
_duse="$(df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
case "$_duse" in
	''|*[!0-9]*) : ;;
	*) if [ "$_duse" -ge 85 ]; then
		DISK_NOTE="NOTE: this VM's disk is ${_duse}% full at startup — docker (images + build cache) and your /tmp share ONE overlay, so if it fills the Bash tool dies with ENOSPC on every command. Check with \`cb-df\`; reclaim with \`docker builder prune -f\` then \`docker image prune -af\`. If Bash is already failing, use your Write tool to drop a report into /home/claude/framework-bugs/ and ask the human to \`docker system prune -af\` / \`dridock vm gc\` on the Mac. (See the Disk discipline section.)"
		dbg "disk MOTD: / is ${_duse}% full at boot"
	fi ;;
esac

# Seed the container-side /dridock skill: a harness self-report the claudebot can run
# from INSIDE (the host `dridock` binary isn't in here). Rewritten every start so it
# stays current after an image update (it's shipped content, not user-editable). Legacy
# /claudebox skill dir (from 2.x images) is removed here for one deprecation cycle so a
# renamed session doesn't ship two overlapping skills.
rm -rf /home/claude/.claude/skills/claudebox 2>/dev/null
CB_SKILL_DIR="/home/claude/.claude/skills/dridock"
mkdir -p "$CB_SKILL_DIR"
cat > "$CB_SKILL_DIR/SKILL.md" <<'CBSKILL'
---
name: dridock
description: Report the dridock harness you are running inside — its version, what changed (CHANGELOG), the convenience commands available (cb-help), and this project's container environment (workspace, cb-net, exposing workloads). Use when asked about the dridock harness/version, available cb-* tools, or the container environment. (You are INSIDE the container — the host `dridock` CLI is not available here.)
---

# dridock — harness self-report (from inside the container)

You run INSIDE a dridock container. Give a quick self-report of your harness
environment. Do NOT try to run the host `dridock` command — it isn't in here.

1. **Version** — print the harness semver you're running: `echo "$DRIDOCK_VERSION"`.
   If a "harness was updated" note appeared this session, mention it.
2. **Convenience commands** — run `cb-help` and show the list of available `cb-*` tools.
3. **What changed** — the harness changelog is at `/opt/dridock/CHANGELOG.md` (point the user there;
   summarize the top entry if they ask).
4. **Environment** — your workspace is `$DRIDOCK_WORKSPACE` (same path as on the host).
   Sibling workloads go on the `cb-net` docker network and are reachable by container
   name; publish ports and address them by the VM IP (the human runs `dridock ip` on
   their Mac). The full orchestration standard is in this project's `CLAUDE.md`.

Keep it a concise self-report, not a deep dive.
CBSKILL
chown -R claude:claude "$CB_SKILL_DIR" 2>/dev/null || true
dbg "seeded container /dridock skill"

# NOTE: we deliberately do NOT create a workspace ./CLAUDE.md. Framework guidance lives in
# ~/.claude/CLAUDE.md (user memory, written above); the project's own ./CLAUDE.md — if any —
# is left entirely to the project. A greenfield project starts with none and creates its own
# (via /init or as it develops). The bootstrap mission brief is surfaced in the user-memory
# file above (conditional on .dridock/BRIEF.md or legacy .claudebox/BRIEF.md). See docs/design/framework-guidance.md.

# ensure .claude.json has required native install properties
# this helps users who mount their existing .claude directory
CLAUDE_CONFIG_DIR="/home/claude/.claude"
CLAUDE_JSON="$CLAUDE_CONFIG_DIR/.claude.json"

mkdir -p "$CLAUDE_CONFIG_DIR"

dbg "configuring .claude.json"
# #37 Tier 1 #10 — the `UPDATED=$(jq …) && printf > …` shape correctly
# avoids truncating $CLAUDE_JSON when jq fails to parse it (jq exits
# non-zero, && short-circuits, no write). But the failure itself is
# silent: startup proceeds as if the patch landed, so the trust prompt
# reappears in the sandbox and settings look wrong with no dridock-level
# trace of why. Fail loud on jq parse failure so the user sees which
# mounted file is malformed.
if [ -f "$CLAUDE_JSON" ]; then
	if ! UPDATED=$(jq '.installMethod = "native" | .autoUpdates = false | .autoUpdatesProtectedForNative = true' "$CLAUDE_JSON" 2>&1); then
		echo "dridock: could not patch $(basename "$CLAUDE_JSON") (invalid JSON in mounted file) — settings.installMethod / autoUpdates NOT applied. jq: $UPDATED" >&2
	else
		printf '%s\n' "$UPDATED" > "$CLAUDE_JSON"
	fi
else
	cp /claude/.claude.json "$CLAUDE_JSON"
fi

if ! UPDATED=$(jq --arg dir "$WORKSPACE_DIR" '.projects[$dir].hasTrustDialogAccepted = true' "$CLAUDE_JSON" 2>&1); then
	echo "dridock: could not patch $(basename "$CLAUDE_JSON") (invalid JSON) — trust dialog for $WORKSPACE_DIR NOT pre-accepted; you'll see the prompt on first run. jq: $UPDATED" >&2
else
	printf '%s\n' "$UPDATED" > "$CLAUDE_JSON"
fi

# Persist permissions.defaultMode=bypassPermissions in settings.json. `--dangerously-skip-
# permissions` at invocation time isn't fully authoritative in newer Claude Code — certain
# operations (e.g. writes under `~/.claude/`) still prompt even with the flag. Setting the
# persistent default closes that gap: the container IS the sandbox, so Claude should never
# prompt inside it. Rewritten on every start so an accidental UI toggle heals on next boot.
SETTINGS_JSON="$CLAUDE_CONFIG_DIR/settings.json"
if [ -f "$SETTINGS_JSON" ]; then
	UPDATED=$(jq '.permissions.defaultMode = "bypassPermissions"' "$SETTINGS_JSON") && \
		printf '%s\n' "$UPDATED" > "$SETTINGS_JSON"
else
	printf '{"permissions":{"defaultMode":"bypassPermissions"}}\n' > "$SETTINGS_JSON"
fi
dbg "settings.json: permissions.defaultMode = bypassPermissions"

chown -R claude:claude "$CLAUDE_CONFIG_DIR"
dbg ".claude.json done"

# run init scripts on first container create (marker lives in container filesystem, not on mount)
INIT_MARKER="/var/run/claude-initialized"
if [ ! -f "$INIT_MARKER" ]; then
	INIT_DIR="/home/claude/.claude/init.d"
	# #37 Tier 1 #3 — capture per-script rc, complain to stderr on failure,
	# and only set the marker if EVERY script succeeded. init.d is the
	# documented durable "escape hatch"; a failed hook silently marked-done
	# forever was a fire-and-forget bug that the user could only discover
	# by noticing the intended setup didn't happen. Now: failure → loud
	# stderr + no marker + retry on next container create.
	init_rc=0
	if [ -d "$INIT_DIR" ]; then
		dbg "first run: executing init scripts from $INIT_DIR"
		for script in "$INIT_DIR"/*.sh; do
			[ ! -f "$script" ] && continue
			dbg "init: running $script"
			bash "$script"
			_rc=$?
			if [ "$_rc" -ne 0 ]; then
				echo "dridock: init.d/$(basename "$script") exited $_rc — will retry on next container create" >&2
				init_rc=1
			else
				dbg "init: $script exited 0"
			fi
		done
	fi
	if [ "$init_rc" -eq 0 ]; then
		touch "$INIT_MARKER"
		dbg "init marker created"
	else
		echo "dridock: init.d had failures — marker NOT set; init scripts will re-run on the next container create" >&2
	fi
fi

# ── durable env sidecars → THIS shell's environment ──────────────────────────
# The wrapper mirrors host-side state into per-role sidecar files under the ~/.claude
# mount — auth, project secrets, the CDP bridge URL, the reachable VM IP, the host-agent
# token — because `docker start` cannot pass new env to an existing container. We re-read
# them on every start so they self-heal (IP rotation, bridge/agent up or down).
#
# These MUST be real `export`s in this shell, NOT `export K=V` appended to the CMD string
# that later runs under `bash -c`. Two independent reasons:
#
#   1. SECURITY. A CMD-string export puts every secret VALUE into PID 1's argv, and
#      /proc/1/cmdline is mode 444 — world-readable by ANY uid in the container, not just
#      the claude user, and trivially scraped by a stray `ps` into logs, bug reports and
#      pasted transcripts. That is exactly how a live GH_TOKEN escaped during #17. The
#      process environment (/proc/1/environ) is mode 400 — owner-only. Both verified on a
#      running container. Secrets belong in the environment, never in a command line;
#      this is the same rule the project CLAUDE.md states for host-side flags.
#
#   2. COVERAGE. The API / telegram / cron daemons `exec` further down, BEFORE the CMD
#      string is ever built, so CMD-string exports never reached them at all — those modes
#      only ever worked because the wrapper ALSO passed the values via `docker run -e`.
#      Exporting here, above the mode dispatch, covers every mode through ordinary env
#      inheritance (no setpriv call uses --reset-env; verified), which is what lets the
#      wrapper stop putting secrets on the docker command line too.
#
# Read with plain `export "$name=$value"` — no printf %q, no eval — so a value containing
# shell metacharacters is data, never code.
_load_env_sidecar() {   # $1 = sidecar suffix, $2 = debug label
	local f="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-$1" line name value
	[ -f "$f" ] || return 0
	dbg "$2 sidecar: $f"
	# Parse KEY=VALUE tolerantly. These files are copied verbatim from a HAND-EDITABLE
	# host file (.dridock/secrets.env), so they pick up human formatting: `KEY = value`,
	# a stray space after `=`, CRLF from an editor, a trailing newline-less last line.
	# The naive `IFS='=' read -r name value` kept every one of those characters, so
	# `GH_TOKEN= ghp_x` exported a token with a LEADING SPACE — every API call rejected,
	# with nothing anywhere saying why. Found in the wild during #17. Surrounding
	# whitespace is never meaningful in a credential, so strip it on both halves.
	while IFS= read -r line || [ -n "$line" ]; do
		line="${line%$'\r'}"                              # tolerate CRLF-saved files
		case "$line" in ''|'#'*) continue ;; esac
		case "$line" in *=*) ;; *) continue ;; esac       # not a KEY=VALUE line
		name="${line%%=*}"; value="${line#*=}"            # split on the FIRST = only
		name="${name#"${name%%[![:space:]]*}"}"; name="${name%"${name##*[![:space:]]}"}"
		value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
		# A name that isn't a shell identifier would make `export` fail (or worse, be
		# reinterpreted). Skip it loudly rather than half-applying the file.
		# NB: validate by EXCLUSION. `[A-Za-z_][A-Za-z0-9_]*` looks right but is a glob,
		# not a regex — `[...]` matches exactly one character and the trailing `*` is
		# "anything", so it demands a name of length >= 2 (rejecting `A`) while happily
		# accepting `A-B`. Wrong in both directions.
		case "$name" in
			''|[0-9]*)        echo "dridock: ignoring malformed entry in $(basename "$f"): '${name}'" >&2; continue ;;
			*[!A-Za-z0-9_]*)  echo "dridock: ignoring malformed entry in $(basename "$f"): '${name}'" >&2; continue ;;
		esac
		if [ -n "$value" ]; then
			dbg "$2: loading $name"
			export "$name=$value"
		else
			# Empty = explicitly cleared host-side (DRIDOCK_NO_API_KEY, bridge down,
			# agent down). UNSET it, so a value baked into an older container at
			# `docker run` time can't linger and override the intended state.
			dbg "$2: clearing $name"
			unset "$name"
		fi
	done < "$f"
}
_load_env_sidecar auth      auth
_load_env_sidecar secrets   secret
_load_env_sidecar cdp       cdp
_load_env_sidecar vmip      vmip
_load_env_sidecar hostagent hostagent
# #30 — DRIDOCK_ENV_* forwarded values.
# Pre-3.3.0 these rode `-e` on docker run only, so a CHANGED value silently
# no-op'd on `docker start` (a container that already existed). Now they also
# land in a chmod-600 `.<name>-env` sidecar the wrapper rewrites each run;
# loading here means new/changed forwards apply on restart. Same loader shape
# as auth/secrets — empty value UNSETs, so `DRIDOCK_ENV_FOO=` explicitly clears
# a baked FOO. Fully REMOVING a forward from a fresh run (unsetting the
# DRIDOCK_ENV_FOO host-side var) does NOT clear the baked value — the loader
# only sees keys the sidecar names. That's #30 Part 2 (--recreate flag), out
# of Part 1 scope; document it in docs/environment-variables.md.
_load_env_sidecar env       forwarded-env

# Env aliasing REMOVED in 5.0.0. Through 4.x this mirrored every
# DRIDOCK_X ↔ CLAUDEBOX_X pair from a rename map so legacy-reading helpers
# kept working. It also made the test suite unable to tell which name a
# green run had actually exercised (#82) — the shim was simultaneously the
# compatibility layer and the thing hiding whether anything else worked.
# Everything now reads DRIDOCK_X only. See docs/roadmap.md.

# ── XDG_CONFIG_HOME → ~/.claude/xdg-config (persistence, #58) ────────────────
# Fix for the silent-event-loss-on-rebuild class Arfy caught in #56 review
# after v4.2.0 shipped: the container's default $HOME/.config lives on the
# EPHEMERAL container FS, not on any bind mount. Verified: `mount | grep
# home/claude` in a running 4.2.0 container lists .claude, .ssh,
# framework-bugs, framework-consult — never .config. So anything under
# XDG_CONFIG_HOME/dridock/ (team-watch cursors, inbox, heartbeat, session
# cursors, pidfiles, logs, respawn stamps) was WIPED on every
# `dridock down + dridock start` post `make build`, and the fetcher
# restarted at nowIso() with zero signal that events posted during the
# down window were dropped.
#
# The fix here is minimal: re-point XDG_CONFIG_HOME at a subdir of the
# already-bind-mounted ~/.claude/. No new mount, no code changes elsewhere,
# no half-host-half-container confusion (Arfy's argument on #58 against
# adding a ~/.config bind mount outright — see the "persistence" section
# in docs/design/agent-teams-delivery.md). Host is unaffected; this export
# is container-only.
#
# Every XDG-consuming subsystem in-container (dridock team watch state, gh
# CLI config, bun cache, etc.) benefits from persistence for free. Chown
# to claude:claude so the setpriv'd child owns it — mkdir here runs as
# root and would default to root:root without an explicit chown.
mkdir -p /home/claude/.claude/xdg-config
chown -R claude:claude /home/claude/.claude/xdg-config 2>/dev/null || true
# chmod 700 the xdg-config root — anything XDG-stored in-container is now
# persistent host-side, and gh's OAuth token in particular lands under
# ~/.config/dridock/projects/<id>/claude/xdg-config/gh/hosts.yml on the
# host. Default umask leaves the directory 0755 = traversable by other
# uids on the host (Arfy has a second Mac account; not hypothetical).
# gh itself chmod's hosts.yml 0600, but a 0755 parent still leaks
# metadata (existence, filenames). Lock the dir to owner-only so the
# credential dir is invisible to other host uids. CLAUDE.md rule:
# credentials live in chmod-600 files — extend that to their containing
# dir too when the containing dir is on host disk.
chmod 700 /home/claude/.claude/xdg-config 2>/dev/null || true
export XDG_CONFIG_HOME=/home/claude/.claude/xdg-config
dbg "XDG_CONFIG_HOME=$XDG_CONFIG_HOME (persistence via ~/.claude bind mount, #58)"

# mode env vars — DRIDOCK_MODE_* only (5.0.0)
_mode_api="${DRIDOCK_MODE_API:-}"
_mode_api_port="${DRIDOCK_MODE_API_PORT:-8080}"
_mode_telegram="${DRIDOCK_MODE_TELEGRAM:-}"
_mode_cron="${DRIDOCK_MODE_CRON:-}"
_mode_cron_file="${DRIDOCK_MODE_CRON_FILE:-}"

# combined telegram + cron mode — run both; cron in background, telegram bot in foreground
if [ "$_mode_telegram" = "1" ] && [ "$_mode_cron" = "1" ]; then
	dbg "mode: telegram + cron (combined)"
	if [ -z "$_mode_cron_file" ]; then
		echo "❌ cron mode enabled but DRIDOCK_MODE_CRON_FILE is not set" >&2
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
	COMBINED_ENV="$COMBINED_ENV; export DRIDOCK_MODE_CRON_FILE=$(printf '%q' "$_mode_cron_file")"
	COMBINED_ENV="$COMBINED_ENV; export DRIDOCK_WORKSPACE=$(printf '%q' "${CLAUDE_WORKSPACE:-/workspace}")"
	COMBINED_ENV="$COMBINED_ENV; export PATH=/home/claude/.claude/bin:/opt/claude-cli/bin:\$PATH"
	# #33 — use absolute /usr/bin/python3, not bare `python3`. The full image
	# has pyenv shims on PATH ahead of /usr/bin, and pyenv's own 3.12 does NOT
	# have the daemon deps (uvicorn/fastapi/mcp/telegram/croniter) — the base
	# stage installed those into the SYSTEM python only. Bare `python3`
	# resolved to pyenv → ModuleNotFoundError → every daemon mode crashed on
	# boot in the shipped image. Absolute path bypasses PATH resolution.
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "$COMBINED_ENV; /usr/bin/python3 /opt/dridock/cron.py & CRON_PID=\$!; trap 'kill \$CRON_PID 2>/dev/null' EXIT INT TERM; /usr/bin/python3 /opt/dridock/telegram_bot.py"
fi

# api mode — run fastapi server instead of claude
if [ "$_mode_api" = "1" ]; then
	dbg "mode: api server (port $_mode_api_port)"
	mkdir -p /workspaces
	chown claude:claude /workspaces
	CLAUDE_UID=$(id -u claude)
	CLAUDE_GID=$(id -g claude)
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "export HOME=/home/claude && export CLAUDE_CONFIG_DIR=/home/claude/.claude && export DRIDOCK_MODE_API_PORT=$_mode_api_port && export PATH=/home/claude/.claude/bin:/opt/claude-cli/bin:\$PATH && exec /usr/bin/python3 /opt/dridock/api_server.py"
fi

# telegram mode — run telegram bot instead of claude
if [ "$_mode_telegram" = "1" ]; then
	dbg "mode: telegram bot"
	mkdir -p /workspaces
	chown claude:claude /workspaces
	CLAUDE_UID=$(id -u claude)
	CLAUDE_GID=$(id -g claude)
	exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups \
		bash -c "export HOME=/home/claude && export CLAUDE_CONFIG_DIR=/home/claude/.claude && export PATH=/home/claude/.claude/bin:/opt/claude-cli/bin:\$PATH && exec /usr/bin/python3 /opt/dridock/telegram_bot.py"
fi

# cron mode — run scheduler that fires claude per cron yaml
if [ "$_mode_cron" = "1" ]; then
	dbg "mode: cron (file: $_mode_cron_file)"
	if [ -z "$_mode_cron_file" ]; then
		echo "❌ cron mode enabled but DRIDOCK_MODE_CRON_FILE is not set" >&2
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
		bash -c "export HOME=/home/claude && export CLAUDE_CONFIG_DIR=/home/claude/.claude && export DRIDOCK_MODE_CRON_FILE=$(printf '%q' "$_mode_cron_file") && export DRIDOCK_WORKSPACE=$(printf '%q' "${CLAUDE_WORKSPACE:-/workspace}") && export PATH=/home/claude/.claude/bin:/opt/claude-cli/bin:\$PATH && exec /usr/bin/python3 /opt/dridock/cron.py"
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

# NOTE: auth and project secrets (GH_TOKEN / GITLAB_TOKEN / … , consumed from the env by
# gh / glab / etc.) are loaded by _load_env_sidecar() ABOVE the mode dispatch — as real
# exports in this shell, never as `export K=V` inside the CMD string, which would publish
# every value in world-readable /proc/1/cmdline. See the block comment there before moving
# this. The harness deliberately does NOT install a git credential helper — git-over-HTTPS
# falls through to SSH via ~/.ssh/claudebox/id_ed25519 (path kept from 2.x for one
# deprecation cycle), the provider-agnostic path for git ops (#10). See
# docs/design/git-and-api-auth.md.

# ── SSH host-key seeding for git-over-SSH (#10) ───────────────────────────────
# 3.0 removed `gh auth setup-git`, so first-connect `git pull|push` via SSH
# hits StrictHostKeyChecking against an empty known_hosts and fails with
# "Host key verification failed". Two-part fix, both landing in the bind-
# mounted ~/.ssh/ (so they persist across container restarts):
#   (1) pre-seed known_hosts with the major providers (real host keys via
#       ssh-keyscan); done once per stamp version so future entrypoint bumps
#       can re-seed by rev'ing the stamp filename.
#   (2) set StrictHostKeyChecking=accept-new as a catch-all in ~/.ssh/config —
#       covers self-hosted / less common providers by accepting on first
#       connect (recording the key in known_hosts for future verification).
# Best-effort throughout: a failed keyscan (offline) is silent — accept-new
# still handles it on the next attempt.
_ssh_seed_hosts() {
	local ssh_dir=/home/claude/.ssh
	local kh="$ssh_dir/known_hosts" cfg="$ssh_dir/config"
	local stamp="$ssh_dir/.dridock-known-hosts-seeded-v1"
	local marker="# dridock: accept-new for first-connect git SSH (#10)"
	[ -d "$ssh_dir" ] || return 0
	if [ ! -f "$stamp" ] && command -v ssh-keyscan >/dev/null 2>&1; then
		touch "$kh" 2>/dev/null || true
		( ssh-keyscan -T 5 github.com gitlab.com bitbucket.org codeberg.org 2>/dev/null; cat "$kh" 2>/dev/null ) \
			| sort -u > "$kh.tmp" 2>/dev/null && mv "$kh.tmp" "$kh" && chmod 644 "$kh"
		touch "$stamp" 2>/dev/null
		chown claude:claude "$stamp" "$kh" 2>/dev/null || true
		dbg "ssh: seeded known_hosts (github/gitlab/bitbucket/codeberg)"
	fi
	if [ ! -f "$cfg" ] || ! grep -qF "$marker" "$cfg" 2>/dev/null; then
		{
			[ -f "$cfg" ] && { cat "$cfg"; echo ""; }
			echo "$marker"
			echo "Host *"
			echo "    StrictHostKeyChecking accept-new"
		} > "$cfg.tmp" 2>/dev/null && mv "$cfg.tmp" "$cfg" && chmod 600 "$cfg"
		chown claude:claude "$cfg" 2>/dev/null || true
		dbg "ssh: appended accept-new fallback to ~/.ssh/config"
	fi
}
_ssh_seed_hosts

# NOTE: the CDP bridge URL (browser-bridge up/down), the reachable VM IP (self-heals when
# colima rotates it — the container cannot see 192.168.64.x itself, so this env is
# claudebot's only reliable source), and the host-agent URL+token are all loaded by
# _load_env_sidecar() above, alongside auth and secrets. Empty value = cleared host-side,
# which unsets rather than lingering.

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
if [ -n "$CONSULT_NOTE" ]; then
	COMBINED_APPEND="${COMBINED_APPEND:+$COMBINED_APPEND

}$CONSULT_NOTE"
fi
if [ -n "$FRAMEWORK_NOTE" ]; then
	COMBINED_APPEND="${COMBINED_APPEND:+$COMBINED_APPEND

}$FRAMEWORK_NOTE"
fi
if [ -n "$DISK_NOTE" ]; then
	COMBINED_APPEND="${COMBINED_APPEND:+$COMBINED_APPEND

}$DISK_NOTE"
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
# where a commit helper is useful. Opt out with DRIDOCK_DEFAULT_PLUGINS=0.
_maybe_install_default_plugin() {
	case "${DRIDOCK_DEFAULT_PLUGINS:-1}" in 0|false) return 0 ;; esac
	[ "${1:-}" = "setup-token" ] && return 0
	[ -f "$ARGS_FILE" ] && return 0                       # programmatic (subsequent) run
	local a; for a in "$@"; do case "$a" in -p|--print) return 0 ;; esac; done
	# One-shot marker (on the per-project mount) — set after a SUCCESSFUL install so we
	# never reinstall: a user who later `plugin uninstall`s it isn't fought. On failure
	# (e.g. offline) the marker isn't set, so a later interactive session retries.
	local marker="$CLAUDE_CONFIG_DIR/.dridock-default-plugins"
	# legacy marker name still respected (one deprecation cycle)
	[ -f "$CLAUDE_CONFIG_DIR/.claudebox-default-plugins" ] && marker="$CLAUDE_CONFIG_DIR/.claudebox-default-plugins"
	[ -f "$marker" ] && return 0
	dbg "installing default plugin commit-commands (first interactive run)…"
	# Two steps: register the marketplace (clones it), then install the plugin by
	# name@marketplace. `plugin install` alone fails ("not found in marketplace") if
	# the marketplace was never added.
	# `</dev/null` is LOAD-BEARING (#17). PID 1 here owns the container's tty, so a
	# helper claude started on this path sits in a non-foreground process group; the
	# moment it touches the terminal it takes SIGTTOU/SIGTTIN and stops (ps state T).
	# `timeout` can't rescue that cleanly and the whole start stalls for the full 90s
	# before falsely reporting "offline". Handing it /dev/null for stdin means there is
	# no terminal to stop on. Measured: without it this call times out (exit 124) every
	# time on a tty-attached start; with it, exit 0. Keep it on every claude/helper
	# invocation the entrypoint makes.
	if timeout 90 setpriv --reuid="$(id -u claude)" --regid="$(id -g claude)" --init-groups \
		bash -c 'export HOME=/home/claude CLAUDE_CONFIG_DIR=/home/claude/.claude PATH=/opt/claude-cli/bin:$PATH; claude plugin marketplace add anthropics/claude-plugins-official && exec claude plugin install commit-commands@claude-plugins-official --scope user' \
		</dev/null >/dev/null 2>&1
	then
		touch "$marker"; chown claude:claude "$marker" 2>/dev/null || true
		dbg "default plugin installed"
	else
		echo "note: default plugin (commit-commands) not installed (offline, or the install timed out) — set DRIDOCK_DEFAULT_PLUGINS=0 to silence" >&2
	fi
}
_maybe_install_default_plugin "$@"

# Install the project's enabled features (wrapper writes the list to ~/.claude/.features
# — with legacy ~/.claude/.profiles read as fallback — from the .dridock config
# `features:` field / `profiles:` alias). Each is a baked bundle at
# /usr/local/lib/dridock/features/<name>/on.sh; run once per feature, marker set only
# on success (so an offline failure retries next start), as the `claude` user,
# best-effort. Backward-compat for 2.x: falls back to /usr/local/lib/dridock/profiles/
# <name>.sh AND recognizes the legacy `.profile-<name>` marker so a project that had
# `profiles: [typescript]` in 2.x doesn't re-run the installer on 3.0's first boot.
# See docs/design/features-system.md.
_install_features() {
	[ "${1:-}" = "setup-token" ] && return 0
	local pf="$CLAUDE_CONFIG_DIR/.features" lib_new="/usr/local/lib/dridock/features"
	local pf_legacy="$CLAUDE_CONFIG_DIR/.profiles" lib_legacy="/usr/local/lib/dridock/profiles"
	local feat marker on_script
	# Prefer the new sidecar; fall back to legacy `.profiles` if only that's present.
	if [ ! -f "$pf" ] && [ -f "$pf_legacy" ]; then pf="$pf_legacy"; fi
	[ -f "$pf" ] || return 0
	for feat in $(cat "$pf" 2>/dev/null); do
		# #37 Tier 1 #8 — was `continue ;` bare, the ONLY silent path in an
		# otherwise-loud loop (unknown-feature + install-failed branches below
		# both echo to stderr). A malformed name (typo, whitespace) got dropped
		# with zero signal. Now: match the loop's own convention — say so.
		case "$feat" in
			''|*[!A-Za-z0-9_-]*)
				echo "dridock: ignoring malformed feature name '$feat' in $pf" >&2
				continue ;;
		esac
		# Either marker suffices — 2.x set `.profile-$feat`, 3.0 sets `.feature-$feat`.
		#
		# But a marker asserts "on.sh ran once", which is NOT "the payload is
		# present" (#75). Those diverge whenever a feature installs outside
		# ~/.claude: the marker is on the bind mount and survives a container
		# recreate, the payload isn't and doesn't — so the feature reports
		# enabled with its tools missing, silently.
		#
		# If the feature ships an optional `check.sh`, run it and treat failure
		# as "not installed" regardless of the marker. Same shape as the
		# team-watch fetcher's two-part liveness (pid AND cmdline): an existence
		# RECORD is not evidence the thing still exists. Features without a
		# check.sh keep the old marker-only behavior.
		if [ -f "$CLAUDE_CONFIG_DIR/.feature-$feat" ] || [ -f "$CLAUDE_CONFIG_DIR/.profile-$feat" ]; then
			_check="$lib_new/$feat/check.sh"
			if [ -x "$_check" ]; then
				if timeout 30 setpriv --reuid="$(id -u claude)" --regid="$(id -g claude)" --init-groups \
					bash -c "export HOME=/home/claude CLAUDE_CONFIG_DIR=/home/claude/.claude PATH=/home/claude/.claude/bin:/opt/claude-cli/bin:\$PATH; exec '$_check'" \
					>/dev/null 2>&1; then
					continue    # marker present AND payload verified
				fi
				echo "dridock: feature '$feat' is marked installed but its check failed — reinstalling (payload likely lost with a container recreate; #75)" >&2
				rm -f "$CLAUDE_CONFIG_DIR/.feature-$feat" "$CLAUDE_CONFIG_DIR/.profile-$feat"
			else
				continue    # no check.sh — marker-only, as before
			fi
		fi
		marker="$CLAUDE_CONFIG_DIR/.feature-$feat"
		# Prefer the 3.0 features/ layout; fall back to legacy profiles/<name>.sh for one cycle.
		if   [ -x "$lib_new/$feat/on.sh" ];    then on_script="$lib_new/$feat/on.sh"
		elif [ -x "$lib_legacy/$feat.sh" ]; then on_script="$lib_legacy/$feat.sh"
		else echo "dridock: unknown feature '$feat' (no $lib_new/$feat/on.sh)" >&2; continue; fi
		dbg "installing feature: $feat (via $on_script)"
		# `</dev/null` for the same reason as the plugin installer above — a feature
		# script that shells out to claude would otherwise stop on the tty and burn
		# the full 120s timeout. See the comment there.
		if timeout 120 setpriv --reuid="$(id -u claude)" --regid="$(id -g claude)" --init-groups \
			bash -c "export HOME=/home/claude CLAUDE_CONFIG_DIR=/home/claude/.claude PATH=/opt/claude-cli/bin:/home/claude/.claude/bin:\$PATH; exec '$on_script'" \
			</dev/null >/dev/null 2>&1
		then
			touch "$marker"; chown claude:claude "$marker" 2>/dev/null || true
			echo "dridock: enabled feature '$feat'" >&2
		else
			echo "dridock: feature '$feat' install failed (offline, or the install timed out) — retries next start" >&2
		fi
	done
}
# Alias for one deprecation cycle (any external caller that grepped for the old name).
_install_profiles() { _install_features "$@"; }
_install_features "$@"

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
	# 3.0.1: user-supplied flags to `dridock start <flags...>` reach here via a
	# durable sidecar the wrapper writes on each invocation. Needed because the
	# interactive path can't use $@ — a) new-container `docker run -it` doesn't
	# forward "$@" past the image (would flip the entrypoint into programmatic
	# mode), and b) re-attach `docker start -ai` can't take new args at all. The
	# sidecar covers both. Consumed once per start; wrapper re-writes it next run.
	INTERACTIVE_ARGS_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-interactive-args"
	INTERACTIVE_EXTRA=""
	if [ -f "$INTERACTIVE_ARGS_FILE" ]; then
		INTERACTIVE_EXTRA="$(cat "$INTERACTIVE_ARGS_FILE")"
		rm -f "$INTERACTIVE_ARGS_FILE"
		dbg "interactive: extra claude args: $INTERACTIVE_EXTRA"
	fi
	# (#16) --remote-control + a setup-token-style CLAUDE_CODE_OAUTH_TOKEN: those
	# tokens are model-request scope only, so Anthropic rejects the RC registration
	# and claude reports no error — the session looks healthy with RC never active.
	#
	# NOTE: the companion check — "does this image's claude even HAVE the flag?"
	# (#17) — deliberately lives HOST-SIDE in wrapper.sh, NOT here. Running
	# `claude --help` from the entrypoint deadlocks: claude touches the container's
	# tty from a non-foreground process group, takes SIGTTOU/SIGTTIN and stops (state
	# T), and `timeout` can't reap a STOPPED process (SIGTERM just stays pending) —
	# so the probe hangs PID 1 forever and no session ever starts. Do not reintroduce
	# a claude invocation on this path.
	case "$INTERACTIVE_EXTRA" in
		*--remote-control*|*--rc*)
			if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
				echo "⚠ dridock: --remote-control needs a FULL-SCOPE claude.ai OAuth login," >&2
				echo "  but CLAUDE_CODE_OAUTH_TOKEN (setup-token style) is set — that token is" >&2
				echo "  model-request-only, so Anthropic rejects the RC registration silently." >&2
				echo "  Fix (one-time per project): inside this session, run 'claude auth login'" >&2
				echo "  and complete the browser OAuth flow; then next launch use:" >&2
				echo "    DRIDOCK_NO_OAUTH_TOKEN=1 dridock start --remote-control" >&2
				echo "  See docs/design/git-and-api-auth.md and https://code.claude.com/docs/en/remote-control" >&2
			fi ;;
	esac
	NO_CONTINUE_FILE="/home/claude/.claude/.${CLAUDE_CONTAINER_NAME}-no-continue"
	if [ -f "$NO_CONTINUE_FILE" ]; then
		rm -f "$NO_CONTINUE_FILE"
		dbg "no-continue flag set, skipping --continue"
		CMD="$CMD && exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG $INTERACTIVE_EXTRA"
	else
		CMD="$CMD && (claude --dangerously-skip-permissions --continue $SYSTEM_HINT_FLAG $INTERACTIVE_EXTRA || exec claude --dangerously-skip-permissions $SYSTEM_HINT_FLAG $INTERACTIVE_EXTRA)"
	fi
fi


CLAUDE_UID=$(id -u claude)
CLAUDE_GID=$(id -g claude)
dbg "exec: setpriv --reuid=$CLAUDE_UID --regid=$CLAUDE_GID --init-groups bash -c \"...\""
dbg "CMD: $CMD"
exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --init-groups bash -c "$CMD"

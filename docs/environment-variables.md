# Environment Variables

Set these on your host (e.g., in `~/.bashrc` or `~/.zshrc`). The wrapper script forwards them into the container automatically. These apply across all modes.

All wrapper/installer config uses the `DRIDOCK_*` prefix in 3.0+. Anything you want available **inside** the container goes through `DRIDOCK_ENV_*` (prefix stripped on the way in). Legacy 2.x names (`CLAUDEBOX_*` / `CLAUDEBOX_ENV_*` / `CLAUDEBOX_MOUNT_*`) and pre-2.x `CLAUDE_*` fallbacks still work for one deprecation cycle, and bare `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `DEBUG` are picked up directly.

| Variable                   | Description                                                                                | Default                   |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| `DRIDOCK_GIT_NAME`         | Git `user.name` inside the container. If unset, falls back to the host's `git config --global user.name` | host git config           |
| `DRIDOCK_GIT_EMAIL`        | Git `user.email` inside the container. If unset, falls back to the host's `git config --global user.email` | host git config           |
| `DRIDOCK_DATA_DIR`         | Override the `.claude` data directory on the host                                          | `~/.claude`               |
| `DRIDOCK_SSH_DIR`          | Override the SSH key directory mounted into the container                                  | `~/.ssh/claudebox`        |
| `DRIDOCK_INSTALL_DIR`      | Where to install the wrapper binary (install-time only; no sudo if user-writable)          | `~/.local/bin`            |
| `DRIDOCK_BIN_NAME`         | Name of the wrapper binary (install-time only)                                             | `dridock`                 |
| `DRIDOCK_IMAGE`            | Override the full image reference used by the wrapper                                       | `dridock:latest`          |
| `DRIDOCK_IMAGE_NAME`       | Override just the local image repo name (tag appended per variant)                         | `dridock`                 |
| `DRIDOCK_MINIMAL`          | When set, use the minimal image variant                                                    | _(none)_                  |
| `DRIDOCK_CAFFEINATE`       | Set to `1` to keep the Mac awake for a foreground dridock session (macOS `caffeinate -w $$`); prevents Colima suspending mid-run. System sleep is only fully held on AC power. Detached daemons (cron/api/telegram) aren't covered. | _(off)_ |
| `DRIDOCK_NO_API_KEY`       | Set to `1` to **never** send an `ANTHROPIC_API_KEY` into the container (even if one is exported on the Mac), so claudebot falls through to whichever Claude **subscription** credential is stored (`claude auth login` full-scope OAuth, or the model-scope `dridock setup-token`) instead of API billing. Also unsets a key baked into an existing container's env. | _(off)_ |
| `DRIDOCK_NO_OAUTH_TOKEN`   | Set to `1` to **never** send `CLAUDE_CODE_OAUTH_TOKEN` (setup-token style) into the container. Relevant only when BOTH are present: a `dridock setup-token`-produced token AND a `claude auth login` full-scope OAuth stored in `~/.claude/.credentials.json`. In that case the env var (model-request scope only) wins over the stored full-scope login, so Remote Control silently refuses to activate; this flag lets the stored login take effect instead. If you've never run `dridock setup-token`, this env var has nothing to suppress. Note: a stale image (Claude CLI older than 2.1.206) is a separate and more common blocker for `--remote-control` — see [Issue #17](https://github.com/aberezin/docker-claudebox/issues/17). Full context: [design/git-and-api-auth.md § Claude Code auth](design/git-and-api-auth.md#claude-code-auth-distinct-from-gitapi-auth-above) and [Issue #16](https://github.com/aberezin/docker-claudebox/issues/16). | _(off)_ |
| `DRIDOCK_ALLOW_SUBDIR`     | Set to `1` to bypass the guard that stops you launching claudebot from inside a `.dridock` / `.claudebox` metadata dir (which would mount that dir as the workspace). | _(off)_ |
| `DRIDOCK_ALLOW_NEW`        | Set to `1` to bypass the guard that stops you from silently creating a fresh project (new `.dridock/config.yml` + a new per-project Colima VM) when running `dridock` in a dir that isn't a dridock project yet. Interactive runs prompt; non-interactive runs abort — this env skips both. Prefer `dridock bootstrap "<intent>"` for a proper new project. | _(off)_ |
| `DRIDOCK_NO_AUTO_MIGRATE`  | Set to `1` to skip the 3.0 auto-migration of a legacy `.claudebox/`-only workspace into a `.dridock/` one on the first `dridock` invocation. The `dridock migrate` verb still works by hand. | _(off — migrate on)_ |
| `DRIDOCK_HARNESS_DEV`      | Set to `1` to force framework-dev mode (entrypoint startup surfacing of cross-project `awaiting-framework` consults + unreviewed framework-bug reports, `dridock harness <verb>` commands, drift-warning skip). Auto-detected when the workspace looks like a dridock harness fork (a `wrapper.sh` at its root containing `DRIDOCK_VERSION=` or the legacy `CLAUDEBOX_VERSION=`); this env is the explicit opt-in for a renamed/relocated fork. Legacy alias: `DRIDOCK_FRAMEWORK_DEV=1` (and `CLAUDEBOX_HARNESS_DEV` still accepted). See [design/framework-dev-mode.md](design/framework-dev-mode.md). | _(auto)_ |
| `DRIDOCK_HARNESS_WATCH_INTERVAL` | Poll interval (seconds) for `cb-harness-watch-consults`, the framework-dev in-container watcher for cross-project `awaiting-framework` consults + new unreviewed framework-bug reports. Positional arg overrides. See [design/framework-dev-mode.md](design/framework-dev-mode.md). | `20` |
| `DRIDOCK_NO_DRIFT_WARN`    | Set to `1` to silence the wrapper's "cb-infra image is behind wrapper" warning that fires on each `dridock` invocation whose cb-infra image lags the wrapper's `DRIDOCK_VERSION`. Auto-skipped for the framework-dev workspace (which is the one causing drift and already knows); this env is the explicit opt-out for scripted / CI contexts where the warning is noise. | _(off — warn on)_ |
| `DRIDOCK_PRUNE_ON_START`   | Set to `1` to have the entrypoint run `docker builder prune -f` (build cache) AND `docker image prune -f` (dangling untagged images) on every container start — keeps the shared VM disk from creeping up on image-iterating projects. Best-effort. Never removes tagged images or a running container's image. See [design/disk-management.md](design/disk-management.md). | _(off)_ |
| `DRIDOCK_TMPFS_TMP`        | RAM-back the claudebot's `/tmp` so docker disk bloat can't starve the Bash tool (`/tmp/claude-501`). Value is a size (`2g`) or `1`/`on` for 2g. Applies on a fresh `docker run`. Sized in RAM — keep modest vs the VM's memory. | _(off)_ |
| `DRIDOCK_HOST_AGENT_PORT` / `DRIDOCK_HOST_AGENT_BIND` | Tune the opt-in host agent (`dridock host-agent up`, Approach 2) — the port and bind address it listens on. **BIND stays the Colima gateway; never set it to `0.0.0.0`/a LAN address.** See [design/backends.md](design/backends.md). | `9280` / `192.168.64.1` |
| `DRIDOCK_INFRA_CPU`        | CPUs for the shared `cb-infra` image-store VM (install-time only)                           | `2`                       |
| `DRIDOCK_INFRA_MEMORY`     | Memory (GiB) for `cb-infra` (install-time; bump if a `full` build runs short)              | `4`                       |
| `DRIDOCK_INFRA_DISK`       | Disk (GiB) for `cb-infra` (install-time only)                                               | `40`                      |
| `DRIDOCK_DEFAULT_PLUGINS`  | Set to `0` to skip seeding the default plugin set (`settings.json`) on first run           | `1` (seed if no settings) |
| `DRIDOCK_CONTAINER_NAME`   | Override the per-workspace container name                                                  | derived from `$PWD`       |
| `DRIDOCK_ENV_*`            | Forward env vars into the container (prefix stripped: `DRIDOCK_ENV_FOO=bar` → `FOO=bar`)   | _(none)_                  |
| `DRIDOCK_MOUNT_*`          | Mount extra host directories into the container                                            | _(none)_                  |

For each `DRIDOCK_*` above, the legacy `CLAUDEBOX_*` name of the same suffix is accepted for one deprecation cycle (removed in 4.0). Where the two are set on the same run, the `DRIDOCK_*` value wins.

Auth and in-container settings go through `DRIDOCK_ENV_*`:

| Forwarded as                     | Set on host as                                 |
| -------------------------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY`              | `DRIDOCK_ENV_ANTHROPIC_API_KEY`                |
| `CLAUDE_CODE_OAUTH_TOKEN`        | `DRIDOCK_ENV_CLAUDE_CODE_OAUTH_TOKEN`          |
| `DEBUG`                          | `DRIDOCK_ENV_DEBUG`                            |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | `DRIDOCK_ENV_CLAUDE_CODE_DISABLE_1M_CONTEXT`   |

## Forwarding environment variables

The `DRIDOCK_ENV_` prefix injects arbitrary env vars into the container. The prefix is stripped before forwarding:

```bash
# inside the container these become: GITHUB_TOKEN=xxx, MY_VAR=hello
DRIDOCK_ENV_GITHUB_TOKEN=xxx DRIDOCK_ENV_MY_VAR=hello dridock "do stuff"
```

**Persistence across `docker start`** (updated in 3.3.0, see #30). Each `DRIDOCK_ENV_*` forward is written to two places: the usual `docker run -e` (which only applies on the first run) AND a chmod-600 `~/.claude/.<container>-env` sidecar the entrypoint re-reads on every start. Consequence:

- **A CHANGED value** — set `DRIDOCK_ENV_FOO=y` when the container was created with `FOO=x`: takes effect on the next run (fixed).
- **An EXPLICITLY CLEARED value** — set `DRIDOCK_ENV_FOO=` (empty): the sidecar loader UNSETs `FOO`, so a value baked in at container-create time is dropped.
- **A REMOVED forward** — omit `DRIDOCK_ENV_FOO` entirely on a subsequent run: the baked value from container-create PERSISTS. To fully drop it, either set `DRIDOCK_ENV_FOO=` on a run OR recreate the container (`docker rm` it and re-run; a `--recreate` shortcut is #30 Part 2).

For **secrets**, `.dridock/secrets.env` below is still the cleaner channel (single source of truth, gitignored, format-checked). `DRIDOCK_ENV_*` is best for one-off / ad-hoc env you don't want to persist to a file.

## Secrets — `.dridock/secrets.env`

Per-project credentials live in `.dridock/secrets.env` (gitignored, `chmod 600`, `KEY=VALUE` per line — comments with `#` allowed). Unlike `DRIDOCK_ENV_*`, the wrapper re-injects it on **every** invocation and persists it to a sidecar the entrypoint re-reads on each start, so secrets survive `docker start`. **Secrets are never accepted on the command line** — put them in this file (or seed it at bootstrap):

```bash
# seed GH_TOKEN from your own host login → claudebot boots authed to GitHub (no `gh auth login`)
dridock bootstrap --gh-token "build project-A"

# or provide a whole file of KEY=VALUE lines (merged into .dridock/secrets.env)
dridock bootstrap --secrets-file ./my-secrets.env "build project-A"

# or just edit .dridock/secrets.env by hand:
#   GH_TOKEN=ghp_...
#   NPM_TOKEN=npm_...
```

`GH_TOKEN` (or `GITHUB_TOKEN`) is picked up by `gh` automatically; the entrypoint additionally runs `gh auth setup-git` so plain `git push https://github.com/...` is authenticated too. Secrets are host-local and never committed — `secrets.env` is auto-added to the project `.gitignore`.

Legacy 2.x projects that still use `.claudebox/secrets.env` continue to work — the wrapper reads either dotname for one deprecation cycle. `dridock migrate` moves the file to the canonical `.dridock/` location.

## Extra volume mounts

The `DRIDOCK_MOUNT_` prefix mounts additional host directories into the container:

```bash
DRIDOCK_MOUNT_DATA=/data dridock "process the data"                    # same path inside container
DRIDOCK_MOUNT_1=/opt/configs DRIDOCK_MOUNT_2=/var/logs dridock "go"    # mount multiple directories
DRIDOCK_MOUNT_STUFF=/host/path:/container/path dridock "do stuff"      # explicit source:dest mapping
DRIDOCK_MOUNT_RO=/data:/data:ro dridock "read the data"                # read-only mount
```

If the value contains `:`, it is passed directly as Docker `-v` syntax. Otherwise, the same path is used on both host and container sides.

## Provided to the container by the harness

You don't set these — the wrapper injects them into the claudebot so it can reason about
its environment. Read them; don't hardcode their values in project source.

| Variable                       | What it is                                                                 |
| ------------------------------ | -------------------------------------------------------------------------- |
| `DRIDOCK_VM_IP`                | The project VM's current reachable IP (`192.168.64.x`). **Rotates** across VM restarts — the wrapper refreshes it every run (durable `-vmip` sidecar). The only address the Mac/browser reaches published workloads at. Also `cb-browser ip`; on the Mac, `dridock ip`. See [design/n-tier-networking.md](design/n-tier-networking.md). |
| `DRIDOCK_HOSTNAME`             | The stable `network.hostname` if the human set one via `dridock net <name>` — the rotation-proof alias for the VM IP. Empty if unset. |
| `DRIDOCK_HOST_CDP_URL`         | Present only while a CDP bridge is up (`dridock browser-bridge up`) — the URL `cb-browser cdp` drives the human's Chrome through. |
| `DRIDOCK_PROJECT_ID`           | This project's stable id (from `.dridock/config.yml`).                     |
| `DRIDOCK_CONSULT_DIR`          | Mount path for the shared consult substrate (`cb-consult`). See [design/framework-consult.md](design/framework-consult.md). |
| `DRIDOCK_HOST_AGENT_URL` / `DRIDOCK_HOST_AGENT_TOKEN` | Injected only while the opt-in host agent is up (`dridock host-agent up`) — the address + per-session token the baked `colima`/`limactl` shims use to proxy to the Mac. See [design/backends.md](design/backends.md). |
| `DRIDOCK_FRAMEWORK_BUGS_DIR`   | Mount path for the shared framework-bug drop (`cb-report-bug`).            |

## Container-side `cb-browser` knobs

Set these in the claudebot's shell to tune `cb-browser`. Container-only (not read by the host wrapper).

| Variable                | What it is                                                                 | Default            |
| ----------------------- | -------------------------------------------------------------------------- | ------------------ |
| `CB_BROWSER_NET`        | Shared docker network for A-side flows (`shot`, `script`, `watch`).       | `cb-net`           |
| `CB_BROWSER_IMAGE`      | Playwright image tag used by A-side flows.                                 | `mcr.microsoft.com/playwright:v${CB_BROWSER_PWVER}-jammy` |
| `CB_BROWSER_PWVER`      | Playwright version used by A-side flows (matches the image's cached browsers). | `1.48.0`      |
| `CB_BROWSER_OUT`        | Artifact directory for A-side flows (mounted at `/out` in the script container). | `$PWD/cb-browser-out` |
| `CB_WATCH_IMAGE`        | headful+noVNC image for `cb-browser watch`.                                | `lscr.io/linuxserver/chromium:latest` |
| `CB_WATCH_PORT`         | port `cb-browser watch` publishes on the VM.                               | `3010`             |
| `CB_WATCH_NAME`         | container name for `cb-browser watch`.                                     | `cb-watch`         |
| `CB_BROWSER_CDP_KEEP`   | Set to `1` to disable `cb-browser script-cdp`'s snapshot-diff tab cleanup on exit. Use when the script deliberately leaves tabs open for the human to inspect. | _(off — cleanup on)_ |

## See also

- [design/3.0-migration.md](design/3.0-migration.md) — the `CLAUDEBOX_*` → `DRIDOCK_*` rename + backward-compat window.
- [design/per-project-vm.md](design/per-project-vm.md) — data dir, secrets, VM sizing.
- [modes/interactive.md](modes/interactive.md) · [modes/programmatic.md](modes/programmatic.md) · [modes/api.md](modes/api.md) — where these vars apply.
- [versioning.md](versioning.md) — `DRIDOCK_VERSION` and drift.

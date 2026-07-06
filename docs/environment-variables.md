# Environment Variables

Set these on your host (e.g., in `~/.bashrc` or `~/.zshrc`). The wrapper script forwards them into the container automatically. These apply across all modes.

All wrapper/installer config uses the `CLAUDEBOX_*` prefix. Anything you want available **inside** the container goes through `CLAUDEBOX_ENV_*` (prefix stripped on the way in). Legacy `CLAUDE_*` / `CLAUDE_ENV_*` / `CLAUDE_MOUNT_*` and bare `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `DEBUG` still work for backwards compat.

| Variable                   | Description                                                                                | Default                   |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| `CLAUDEBOX_GIT_NAME`       | Git `user.name` inside the container. If unset, falls back to the host's `git config --global user.name` | host git config           |
| `CLAUDEBOX_GIT_EMAIL`      | Git `user.email` inside the container. If unset, falls back to the host's `git config --global user.email` | host git config           |
| `CLAUDEBOX_DATA_DIR`       | Override the `.claude` data directory on the host                                          | `~/.claude`               |
| `CLAUDEBOX_SSH_DIR`        | Override the SSH key directory mounted into the container                                  | `~/.ssh/claudebox`        |
| `CLAUDEBOX_INSTALL_DIR`    | Where to install the wrapper binary (install-time only; no sudo if user-writable)          | `~/.local/bin`            |
| `CLAUDEBOX_BIN_NAME`       | Name of the wrapper binary (install-time only)                                             | `claudebox`               |
| `CLAUDEBOX_IMAGE`          | Override the full image reference used by the wrapper                                       | `claudebox:latest`        |
| `CLAUDEBOX_IMAGE_NAME`     | Override just the local image repo name (tag appended per variant)                         | `claudebox`               |
| `CLAUDEBOX_MINIMAL`        | When set, use the minimal image variant                                                    | _(none)_                  |
| `CLAUDEBOX_INFRA_CPU`      | CPUs for the shared `cb-infra` image-store VM (install-time only)                           | `2`                       |
| `CLAUDEBOX_INFRA_MEMORY`   | Memory (GiB) for `cb-infra` (install-time; bump if a `full` build runs short)              | `4`                       |
| `CLAUDEBOX_INFRA_DISK`     | Disk (GiB) for `cb-infra` (install-time only)                                               | `40`                      |
| `CLAUDEBOX_DEFAULT_PLUGINS` | Set to `0` to skip seeding the default plugin set (`settings.json`) on first run           | `1` (seed if no settings) |
| `CLAUDEBOX_CONTAINER_NAME` | Override the per-workspace container name                                                  | derived from `$PWD`       |
| `CLAUDEBOX_ENV_*`          | Forward env vars into the container (prefix stripped: `CLAUDEBOX_ENV_FOO=bar` → `FOO=bar`) | _(none)_                  |
| `CLAUDEBOX_MOUNT_*`        | Mount extra host directories into the container                                            | _(none)_                  |

Auth and in-container settings go through `CLAUDEBOX_ENV_*`:

| Forwarded as                     | Set on host as                                 |
| -------------------------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY`              | `CLAUDEBOX_ENV_ANTHROPIC_API_KEY`              |
| `CLAUDE_CODE_OAUTH_TOKEN`        | `CLAUDEBOX_ENV_CLAUDE_CODE_OAUTH_TOKEN`        |
| `DEBUG`                          | `CLAUDEBOX_ENV_DEBUG`                          |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | `CLAUDEBOX_ENV_CLAUDE_CODE_DISABLE_1M_CONTEXT` |

## Forwarding environment variables

The `CLAUDEBOX_ENV_` prefix injects arbitrary env vars into the container. The prefix is stripped before forwarding:

```bash
# inside the container these become: GITHUB_TOKEN=xxx, MY_VAR=hello
CLAUDEBOX_ENV_GITHUB_TOKEN=xxx CLAUDEBOX_ENV_MY_VAR=hello claudebox "do stuff"
```

`CLAUDEBOX_ENV_*` is injected via `docker run -e`, so it only applies on the **first** run of a container. A restarted (`docker start`) container does **not** see it. For anything that must survive restarts — especially **secrets** — use the per-project secrets file below.

## Secrets — `.claudebox/secrets.env`

Per-project credentials live in `.claudebox/secrets.env` (gitignored, `chmod 600`, `KEY=VALUE` per line — comments with `#` allowed). Unlike `CLAUDEBOX_ENV_*`, the wrapper re-injects it on **every** invocation and persists it to a sidecar the entrypoint re-reads on each start, so secrets survive `docker start`. **Secrets are never accepted on the command line** — put them in this file (or seed it at bootstrap):

```bash
# seed GH_TOKEN from your own host login → claudebot boots authed to GitHub (no `gh auth login`)
claudebox bootstrap --gh-token "build project-A"

# or provide a whole file of KEY=VALUE lines (merged into .claudebox/secrets.env)
claudebox bootstrap --secrets-file ./my-secrets.env "build project-A"

# or just edit .claudebox/secrets.env by hand:
#   GH_TOKEN=ghp_...
#   NPM_TOKEN=npm_...
```

`GH_TOKEN` (or `GITHUB_TOKEN`) is picked up by `gh` automatically; the entrypoint additionally runs `gh auth setup-git` so plain `git push https://github.com/...` is authenticated too. Secrets are host-local and never committed — `secrets.env` is auto-added to the project `.gitignore`.

## Extra volume mounts

The `CLAUDEBOX_MOUNT_` prefix mounts additional host directories into the container:

```bash
CLAUDEBOX_MOUNT_DATA=/data claudebox "process the data"                    # same path inside container
CLAUDEBOX_MOUNT_1=/opt/configs CLAUDEBOX_MOUNT_2=/var/logs claudebox "go"  # mount multiple directories
CLAUDEBOX_MOUNT_STUFF=/host/path:/container/path claudebox "do stuff"      # explicit source:dest mapping
CLAUDEBOX_MOUNT_RO=/data:/data:ro claudebox "read the data"                # read-only mount
```

If the value contains `:`, it is passed directly as Docker `-v` syntax. Otherwise, the same path is used on both host and container sides.

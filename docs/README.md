# claudebox documentation

Documentation for this fork of claudebox — Claude Code in a per-project Colima VM.
New here? Start with the top-level [README](../README.md) for install + quick start,
and [`CLAUDE.md`](../CLAUDE.md) for the repo conventions.

## Reference  

| Doc | What it covers |
|---|---|
| [environment-variables.md](environment-variables.md) | Every `CLAUDEBOX_*` setting; `CLAUDEBOX_ENV_*` (forward vars), `CLAUDEBOX_MOUNT_*` (extra mounts), secrets, caffeinate. |
| [customization.md](customization.md) | `~/.claude/bin` scripts, `init.d` hooks, always-active skills, MCP servers, plugins, and **profiles**. |
| [versioning.md](versioning.md) | Semver, the host↔image contract, release steps, and `claudebox checkversion`. |
| [documentation.md](documentation.md) | How to document this framework — house style, the `See also` rule, and the Mermaid convention (+ the `;` gotcha). |

## Modes

| Mode | What it covers |
|---|---|
| [interactive](modes/interactive.md) | The default TTY session. |
| [programmatic](modes/programmatic.md) | One-shot `-p` runs (JSON output). |
| [api](modes/api.md) | The HTTP server — native REST, OpenAI-compatible, and MCP surfaces. |
| [telegram](modes/telegram.md) | The Telegram bot. |
| [cron](modes/cron.md) | The scheduler daemon. |

## Design

| Doc | What it covers |
|---|---|
| [per-project-vm.md](design/per-project-vm.md) | The core: one isolated Colima VM per project, identity, image seeding, VM lifecycle. |
| [bootstrap.md](design/bootstrap.md) | `claudebox bootstrap` — scaffolding a project + the durable `BRIEF.md`; secrets. |
| [multi-repo-projects.md](design/multi-repo-projects.md) | One project/VM spanning several repos. |
| [profiles.md](design/profiles.md) | Opt-in tool bundles (`profiles: [...]`) and the bake-vs-install policy. |
| [convenience-scripts.md](design/convenience-scripts.md) | The container-side `cb-*` command convention + `cb-help`. |
| [browser-testing.md](design/browser-testing.md) | `cb-browser` (headless/noVNC) and the opt-in CDP bridge to your real Chrome. |
| [n-tier-networking.md](design/n-tier-networking.md) | The standard for addressing/binding/CORS in multi-tier apps (service-name vs rotating VM IP). |
| [disk-management.md](design/disk-management.md) | The standard for docker-disk under the per-project VM — prune discipline, `cb-df`, the ENOSPC/Write-tool escape. |
| [framework-guidance.md](design/framework-guidance.md) | How framework guidance reaches every claudebot — `~/.claude/CLAUDE.md` (user memory), rewritten each start. |
| [framework-consult.md](design/framework-consult.md) | Supervised claudebot ↔ framework-Claude threads that turn recurring problems into baked standards. |
| [backends.md](design/backends.md) | Design sketch (#15): developing/testing the harness off the Mac — a docker backend vs proxying Colima to the host. |
| [framework-bug-reporting.md](design/framework-bug-reporting.md) | `cb-report-bug` — claudebot flags harness bugs to the host. |

## See also

- [README](../README.md) — install, quick start, what's inside the image.
- [CLAUDE.md](../CLAUDE.md) — repo conventions (architecture, versioning, `cb-*`, profiles).
- [CHANGELOG.md](../CHANGELOG.md) — the fork's release history.

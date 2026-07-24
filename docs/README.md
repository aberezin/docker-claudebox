# dridock documentation

Documentation for this fork of claudebox — Claude Code in a per-project Colima VM.
(The fork was rebranded from `claudebox` to `dridock` in 3.0; canonical layout is
`.dridock/` project dirs and `DRIDOCK_*` env vars, with legacy `.dridock/` ← `.claudebox/`
project dirs + `CLAUDEBOX_*` env vars still read for one deprecation cycle.
See [design/3.0-migration.md](design/3.0-migration.md) for the migration.)
New here? Start with the top-level [README](../README.md) for install + quick start,
and [`CLAUDE.md`](../CLAUDE.md) for the repo conventions.

## Reference  

| Doc | What it covers |
|---|---|
| [environment-variables.md](environment-variables.md) | Every `DRIDOCK_*` setting (legacy `CLAUDEBOX_*` accepted); `DRIDOCK_ENV_*` (forward vars), `DRIDOCK_MOUNT_*` (extra mounts), secrets, caffeinate. |
| [customization.md](customization.md) | `~/.claude/bin` scripts, `init.d` hooks, always-active skills, MCP servers, plugins, and **profiles**. |
| [versioning.md](versioning.md) | Semver, the host↔image contract, release steps, and `dridock checkversion`. |
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
| [3.0-migration.md](design/3.0-migration.md) | The `dridock` rebrand + coordinated 3.0 migration guide. |
| [per-project-vm.md](design/per-project-vm.md) | The core: one isolated Colima VM per project, identity, image seeding, VM lifecycle. |
| [bootstrap.md](design/bootstrap.md) | `dridock bootstrap` — scaffolding a project + the durable `BRIEF.md`; secrets. |
| [multi-repo-projects.md](design/multi-repo-projects.md) | One project/VM spanning several repos. |
| [features-system.md](design/features-system.md) | 3.0 (#5): opt-in bundles via `features: [...]` — manifest, on/off scripts, CLI. Supersedes profiles. |
| [profiles.md](design/profiles.md) | Legacy 2.x profile system (superseded by features; kept for backward-compat read). |
| [convenience-scripts.md](design/convenience-scripts.md) | The container-side `cb-*` command convention + `cb-help`. |
| [browser-testing.md](design/browser-testing.md) | `cb-browser` (headless/noVNC) and the opt-in CDP bridge to your real Chrome. |
| [n-tier-networking.md](design/n-tier-networking.md) | The standard for addressing/binding/CORS in multi-tier apps (service-name vs rotating VM IP). |
| [host-mcp-servers.md](design/host-mcp-servers.md) | Reaching an MCP server on the Mac host (IDE MCP servers) — the DNS-rebinding `Host`-header 403 and the L7 rewrite-proxy fix. |
| [agent-to-agent.md](design/agent-to-agent.md) | The standard for agent↔agent comms — why **A2A** (not MCP, not ACP), and the waker problem it doesn't solve. |
| [agent-teams.md](design/agent-teams.md) | Spec for teams of **named** agents — the `Sender:` / `Sender->Recipient:` message header, identity/roster, the watcher delivery predicate, and channel routing. |
| [agent-coordination-hooks.md](design/agent-coordination-hooks.md) | The interim two-layer hook pattern (SessionStart catch-up + persistent Monitor) that carries Bear↔Arfy coordination via GitHub-as-bus until A2A + waker land. Protocol-agnostic. |
| [disk-management.md](design/disk-management.md) | The standard for docker-disk under the per-project VM — prune discipline, `cb-df`, the ENOSPC/Write-tool escape. |
| [git-and-api-auth.md](design/git-and-api-auth.md) | The SSH-for-git / tokens-for-API-only split (#10) — provider-agnostic, no credential-helper hijack. |
| [env-var-rename.md](design/env-var-rename.md) | 3.x compat standard for CLAUDEBOX_* ↔ DRIDOCK_* env vars — the shared `env-rename.map` + symmetric aliaser on both sides (host wrapper + container entrypoint). Removed in 4.0. |
| [framework-guidance.md](design/framework-guidance.md) | How framework guidance reaches every claudebot — `~/.claude/CLAUDE.md` (user memory), rewritten each start. |
| [framework-consult.md](design/framework-consult.md) | Supervised claudebot ↔ framework-Claude threads that turn recurring problems into baked standards. |
| [backends.md](design/backends.md) | Developing/testing the harness off the Mac — the docker backend + the host-agent proxy, and the security model. |
| [developing-in-a-claudebox.md](design/developing-in-a-claudebox.md) | Runbook: the dev loop for editing/building/testing the harness *inside* a dridock container (dogfooding). |
| [framework-bug-reporting.md](design/framework-bug-reporting.md) | `cb-report-bug` — claudebot flags harness bugs to the host. |

## See also

- [README](../README.md) — install, quick start, what's inside the image.
- [CLAUDE.md](../CLAUDE.md) — repo conventions (architecture, versioning, `cb-*`, profiles).
- [CHANGELOG.md](../CHANGELOG.md) — the fork's release history.

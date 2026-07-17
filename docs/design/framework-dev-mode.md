# Framework-dev mode

**Status:** Established convention (2026-07-17). Consolidation of framework-dev
functionality that grew organically across 2.16.0 → 2.21.1; a decision doc + inventory,
not a new mechanism.

**Applies to:** any claudebot whose workspace **is** a claudebox harness fork (i.e.,
this project's own harness being iterated on from inside a container).

## What it is

Framework-dev mode is the **runtime mode** the harness enters when the claudebot's
workspace is a claudebox harness fork itself. It is **auto-detected by a workspace
fingerprint** — the `cb_is_framework_dev` helper in `wrapper.sh` returns true when
`$CB_PROJECT_ROOT/wrapper.sh` exists and contains a `CLAUDEBOX_VERSION=` line.
`CLAUDEBOX_HARNESS_DEV=1` forces the mode for a renamed/relocated fork
(see [environment-variables.md](../environment-variables.md); the legacy
`CLAUDEBOX_FRAMEWORK_DEV` alias is still accepted for backward compat).

**It is a mode, not a feature.** You don't opt in per project — you're either developing
the harness or you aren't. Because it's a mode, it deliberately does **not** fit into the
(planned) plugin/features system tracked as
[Issue #5](https://github.com/aberezin/docker-claudebox/issues/5) — that's for
project-level opt-ins (SSH-keygen, browser-bridge, host-agent, etc.) with clean on/off
boundaries. Framework-dev-mode cross-cuts many commands + surfacing and never gets
explicitly "enabled"; plugins gate feature units. Trying to squeeze the fingerprint check
into a `features:` list would conflate two distinct concerns.

**Substrate**: framework-dev mode is only viable because 2.15.0 made `make build` and
the integration suite backend-aware via `CLAUDEBOX_BACKEND=docker` (auto when
`/.dockerenv` exists). Inside a framework-dev claudebot, builds and tests hit the
container's own VM daemon — not the Mac's cb-infra. See [backends.md](backends.md) for
that design.

## What it currently gives you

Inventory of every framework-dev behavior baked in as of 2.21.1, with pointers:

| Behavior | Where it lives | Since |
|---|---|---|
| Startup surfacing of cross-project `awaiting-framework` consults + unreviewed framework-bug reports | `entrypoint.sh` (framework-dev block after the CLAUDE.md HEREDOC) | 2.16.0 |
| `cb-consult list --all` (cross-project consult view) | `cb-consult` (opt-in flag on the general helper) | 2.16.0 |
| `cb-report-bug list / show / done` (management surface for the drop dir) | `cb-report-bug` (subcommands on the general helper) | 2.16.0 |
| **Skip** the "cb-infra image is behind wrapper" drift warning | `wrapper.sh:cb_check_infra_drift` | 2.19.0 |
| `claudebox harness sync` — rebuild cb-infra from the current wrapper checkout | `wrapper.sh:cb_harness_sync` + dispatch under `harness)` | 2.20.0 |
| `claudebox harness sync --repair` — auto-recover from BuildKit snapshotter corruption | `wrapper.sh:cb_harness_sync` (flag) | 2.21.0 |
| `cb_is_framework_dev` helper (the fingerprint check + env-var override) | `wrapper.sh` (single source of truth) | 2.20.0 (extracted from 2.19.0's inline check); env override unified in 2.22.0 |
| **`cb-harness-watch-consults`** — in-container watcher for cross-project `awaiting-framework` consults + new unreviewed framework-bug reports; run as background task | new baked helper (`cb-harness-<name>`, first application of this doc's convention) | 2.22.0 |

Additions after this doc lands (2026-07-17+) should follow the convention below.

## Convention: where new framework-dev code goes

Two paths depending on which side (host vs container) the new capability lives on.

### Host-side (new `claudebox` subcommands)

Extend the **`claudebox harness <verb>`** namespace (2.20.0). New verbs go there, not at
the top level. Rationale:

- **Discoverable** — one line in `claudebox --help`, marked `framework-dev:` (same
  pattern as `host-agent`'s `TRUSTED` tag) so non-dev users see it, register it as
  not-for-them, and skip past.
- **Gated cleanly** — `cb_harness_<verb>` functions call `cb_is_framework_dev` and error
  out clearly if the workspace isn't a harness fork. No accidental firing in gammaray.
- **Preserves the top-level namespace** for user-facing commands.

Function-naming convention: `cb_harness_<verb>` (mirrors the CLI verb name). Shared
logic goes into `cb_harness_*` helpers, not free-floating `cb_*`.

### Container-side (new baked helpers)

Name new baked helpers **`cb-harness-<name>`** (parallel to `cb-*` for general helpers).
Ship them in `/usr/local/bin/` via the Dockerfile like the other `cb-*`. Rationale:

- **Clean grep target** — `ls /usr/local/bin/cb-harness-*` enumerates the framework-dev
  container surface at a glance.
- **`cb-help` separation** — the summary header line in each helper (`# summary: ...`)
  lets `cb-help` group them if we ever want a section separator.
- **Composes with the fingerprint check** — a `cb-harness-*` helper can assume
  framework-dev-mode context and doesn't need to re-check per-invocation, since a
  non-framework-dev claudebot has no reason to invoke one (the entrypoint's framework-dev
  surfacing points here; general claudebot guidance doesn't).

### Existing exceptions (grandfathered)

`cb-consult list --all` and `cb-report-bug list / show / done` are framework-dev-only
behaviors added as flags/subcommands on general helpers rather than as new files. They
predate this convention; leave them where they are. Rules of thumb:

- **New verb** on an existing general helper that only makes sense in framework-dev mode
  → still fine to add there (e.g., an upcoming `cb-consult watch --all` for the live
  cross-project awaiting-framework watcher). Symmetry with `list --all` wins over
  cross-file cohesion for a one-flag addition.
- **New standalone command** for framework-dev → use the naming convention above
  (`cb-harness-<name>` or `claudebox harness <verb>`). The `harness` namespace is
  specifically to prevent a slow accretion of framework-dev-only free-floating cb-* /
  claudebox subcommands.
- **Moving existing framework-dev subcommands** for consistency → churn without payoff.
  Don't.

### Env-var naming convention

Env vars that gate or tune framework-dev-mode behavior use the **`CLAUDEBOX_HARNESS_*`**
prefix (mirrors the `claudebox harness <verb>` / `cb-harness-<name>` / `cb_harness_<verb>`
naming). Established 2.22.0. Current inventory:

| Env var | Effect | Default |
|---|---|---|
| `CLAUDEBOX_HARNESS_DEV=1` | Force framework-dev mode (bypasses the fingerprint check). Used for a renamed/relocated fork whose `wrapper.sh` no longer contains `CLAUDEBOX_VERSION=`. | auto-detected via fingerprint |
| `CLAUDEBOX_HARNESS_WATCH_INTERVAL=<secs>` | Poll interval for `cb-harness-watch-consults`. | 20 |

**Backward compat**: `CLAUDEBOX_FRAMEWORK_DEV=1` is honored as an alias for
`CLAUDEBOX_HARNESS_DEV=1` (renamed 2.22.0; the old name predates the convention).
Follows the same `CLAUDE_* → CLAUDEBOX_*` alias pattern already in the wrapper.

**Not framework-dev knobs** (documented elsewhere), even though they interact:
`CLAUDEBOX_NO_DRIFT_WARN=1` silences a warning that's already auto-skipped in
framework-dev mode, so it targets non-framework-dev users needing to silence it in
scripted/CI contexts.

## Why not consolidate more aggressively?

Considered and rejected:

- **A single sourced `harness/` module in wrapper.sh** — real code motion, meaningful
  cohesion win, but the actual shared code is small (`cb_is_framework_dev` is one
  function; the surfacing block is ~35 lines in `entrypoint.sh`). A 2.x → 3.0 rename
  candidate at best; premature now.
- **Making framework-dev "a plugin"** — see the "mode not a feature" argument above.
  Would conflate the runtime-mode concept with the opt-in feature-flag surface, poor
  fit for both.

## Related

- [backends.md](backends.md) — the `CLAUDEBOX_BACKEND=docker` substrate framework-dev
  mode rides on.
- [framework-consult.md](framework-consult.md) · [framework-bug-reporting.md](framework-bug-reporting.md)
  — the two channels framework-dev-mode's surfacing brings into a claudebot's context.
- [framework-guidance.md](framework-guidance.md) — where the baked-in claudebot
  guidance lives (the `entrypoint.sh` HEREDOC that also emits the framework-dev
  surfacing block).
- [../versioning.md](../versioning.md) — the SDLC that framework-dev-mode changes ship
  under (per-verb PATCH/MINOR bumps).
- [../environment-variables.md](../environment-variables.md) —
  `CLAUDEBOX_HARNESS_*` env family and related.
- [Issue #5](https://github.com/aberezin/docker-claudebox/issues/5) — the plugin/features
  system for **project-level** opt-ins. Distinct concern from framework-dev-mode; keep
  them separate.
- Label on the backlog:
  [`framework-dev`](https://github.com/aberezin/docker-claudebox/labels/framework-dev)
  — apply to Issues that affect this mode.

# Changelog

All notable changes to **dridock** (renamed from `claudebox` at 3.0; upstream was `docker-claude-code` before that).

Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions before `v1.0.0` are pre-release; the upstream rename to `claudebox` at `v1.0.0` and this fork's rename to `dridock` at `3.0.0` are the two breaking name changes in the project's history.

> **Fork note:** this fork maintains its **own** semver line, starting at `2.0.0`
> (2026-07-06) — chosen at the time to sit **above** upstream's then-highest tag
> (`v1.11.0`) so version/tag ordering was coherent across the shared lineage.
>
> **Fork/upstream directions have since diverged (2026-07-17 audit — issue #8):**
> upstream `psyb0t/docker-claudebox` also went to `2.x` starting at their own
> `v2.0.0` (2026-07-04, two days before this fork's `v2.0.0`) — but as a full
> architectural rebase onto a shared `psyb0t/aicodebox` base image. That direction
> is orthogonal to this fork's (macOS + per-project Colima VM + framework-Claude
> tooling + `harness` namespace + dridock rebrand), so upstream commits are not
> merge-compatible. Only the tag name `v2.0.0` collides between the two lineages —
> pointing at completely different commits. See
> [docs/design/upstream-sync.md](docs/design/upstream-sync.md) for the audit and
> policy.
>
> The `v1.x` history further below is upstream claudebox's up to the fork point.
> Detailed fork changes *between* the fork point and `2.0.0` were **not** recorded
> here (see the git history and the README's
> [What's different in this fork](README.md#whats-different-in-this-fork)); the
> changelog is authoritative from `2.0.0` onward. Release process:
> [docs/versioning.md](docs/versioning.md).

## [3.2.4] — 2026-07-21 _(fork)_

### Fixed — defect sweep from #18 QA (bear + arfy)

Three 3.0-rebrand blind spots (each a different syntactic shape than the
prior sweeps caught) plus two test-fixture defects, all surfaced during the
mode-verification pass on issues #18–#23:

- **#26** — the four Python daemons (`api_server.py`, `cron.py`,
  `telegram_bot.py`, `telegram_utils.py`) were reading their config env
  via `os.environ.get("CLAUDEBOX_X")` on the legacy name only (10 sites).
  The container-side aliaser masked it today; 4.0 would silently break
  auth/config for any user who set the `DRIDOCK_X` name. Migrated all 10
  sites to `os.environ.get("DRIDOCK_X") or os.environ.get("CLAUDEBOX_X") or
  os.environ.get("CLAUDE_X", default)` — three-tier fallback matching the
  cb-* helper migration in 3.2.2. Also fixed `api_server.py` error message
  and `cron.py` docstring to reference `DRIDOCK_MODE_CRON_FILE` etc.
- **#29** — four host-side state subdirs (`cdp`, `consult`,
  `framework-bugs`, `host-agent`) still hardcoded `~/.config/claudebox/`
  and `dridock migrate` did not relocate them, silently splitting durable
  state across two roots indefinitely — the "3 framework bug report(s)
  on file" warning was reading from the legacy path in current 3.2.3
  output. `wrapper.sh` now uses a `_cb_state_home <subname>` helper with
  the per-subdir dridock/-preferred, claudebox/-fallback pattern (same
  shape as `cb_xdg_dir`), and `cb_migrate_state_dirs` moves the four
  subdirs when `dridock migrate` (or auto-migrate) runs.
- **`test_cron.sh:77`** stale assertion — `cron.py:423` was updated during
  3.0 to say `DRIDOCK_MODE_CRON_FILE not set` but the test still asserted
  the legacy string. Fixed the assertion.
- **`test_programmatic_bad_auth`** false-pass — asserted `exit != 0` only,
  which the "cb-infra colima profile not found" wrapper-startup error
  also produces. Now additionally requires stderr to mention
  auth/credential/token/oauth/401 so wrapper-startup failures don't
  masquerade as "auth was checked and rejected".

### Added

- **`test_programmatic_auto_continue`** — durable regression check for the
  auto-continue behavior, using **sessionId** in the JSON output rather
  than model recall. The recall-based approach in #18's manual batch
  produced a false-negative from Claude Code's persistent memory writing
  "remember the number N" to a memory file that a fresh session read back;
  sessionId is the direct semantic invariant. House rule for future test
  authoring: never assert on model recall of an arbitrary value.
- **`test_programmatic_json_schema`** — durable regression check for
  `--json-schema`, using inline JSON as the flag actually accepts (a
  path-argument fixture at #18 verify hit a JSON parse error).

### Migration

`dridock migrate` (and the auto-migrate hook) now relocates the four
`~/.config/claudebox/{cdp,consult,framework-bugs,host-agent}` directories
to `~/.config/dridock/`. Users who already ran `dridock migrate` before
3.2.4 should run it again to pick up the new subdirs. Read-fallback
means unmigrated legacy subdirs remain readable for one deprecation cycle.

## [3.2.3] — 2026-07-21 _(fork)_

### Fixed

- **Systematic post-3.0-rebrand audit closed 15 more legacy-only reads**
  (#16 f/u2). `tests/test_rename_completeness.sh` (new — 7-sweep diagnostic
  covering bare `${CLAUDEBOX_X:-}` reads, hardcoded `.claudebox/` paths,
  `claudebox:latest` image tag, XDG `.config/claudebox/` +
  `.local/share/claudebox/`, `skills/claudebox/`, `claudebox <verb>` in
  user-facing strings, and `env-rename.map` completeness) surfaced them.
  All in code that Phase 5's ad-hoc sweep missed:

  - `install.sh` — 6 env vars gained `${DRIDOCK_X:-${CLAUDEBOX_X:-…}}`
    fallbacks: `INSTALL_DIR`, `MINIMAL`, `INFRA_PROFILE`, `INFRA_CPU`,
    `INFRA_MEMORY`, `INFRA_DISK`, `SKIP_SHELL_HELPERS`, `SHARE_DIR`.
  - `tests/common.sh` — `CLAUDEBOX_BACKEND` → `DRIDOCK_BACKEND`-first
    (backend selection in the test harness).
  - `run-e2e-cron-telegram.sh` + `tests/test_e2e_telegram.sh` — 3 sites
    reading `CLAUDEBOX_TELEGRAM_BOT_TOKEN` bare now prefer
    `DRIDOCK_TELEGRAM_BOT_TOKEN` with the legacy as fallback.

- **`~/.local/share/{dridock,claudebox}/` collision handling** (install.sh
  post-2.x-upgrade case). Mirrors the existing `cb_xdg_dir` pattern for
  `~/.config/…`: install writes to `~/.local/share/dridock/` (new
  default), the wrapper reads from `dridock/` first with `claudebox/` as
  fallback (so a 2.x user whose `~/.zshrc` still sources the legacy path
  isn't stranded), and if both dirs co-exist post-upgrade install.sh
  prints a one-liner note recommending `rm -rf` of the legacy dir.
  Never auto-moves — user might have their own files there.

### Added

- **`env-rename.map` gained 14 pairs** the ad-hoc renaming missed —
  `DRIDOCK_INSTALL_DIR`, `DRIDOCK_INFRA_{PROFILE,CPU,MEMORY,DISK}`,
  `DRIDOCK_SKIP_{SHELL_HELPERS,SKILL}`, `DRIDOCK_SHARE_DIR`,
  `DRIDOCK_BACKEND`, `DRIDOCK_NO_{OAUTH_TOKEN,AUTO_MIGRATE}`,
  `DRIDOCK_MODE_{API,API_PORT,API_TOKEN,TELEGRAM}`,
  `DRIDOCK_TELEGRAM_BOT_TOKEN`. The container-side aliaser and host-side
  wrapper alias both pick these up automatically now — the whole point
  of the shared-map design in 3.2.1.

- **`tests/test_rename_completeness.sh`** (new, 7 sweeps, diagnostic
  runnable as `bash tests/test_rename_completeness.sh -v` for detail).
  Exit 1 on any FAIL (real bug); WARN-only is exit 0. Sweep types:
  bare CLAUDEBOX_X reads outside cb-*, hardcoded `.claudebox/` paths,
  `claudebox:latest` image tag, XDG paths, `skills/claudebox/`,
  `claudebox <verb>` in user-facing strings, `env-rename.map`
  completeness (every used `${DRIDOCK_X}` has a map entry or an
  explicit exemption for prefixes / test fixtures / internal names).
  OK-detection is smart: recognizes elif/case legacy branches, paired
  gitignore lines, migration string literals in legacy-aware files,
  and same-line fallback shapes. Down from 26 FAILs on first run to
  0 after the ~15 real bugs were fixed.

- **`~/.local/share/claudebox/env-rename.map`** added to the wrapper's
  map-lookup fallback list — so a 2.x user who happens to have that
  path populated (unlikely, but zero-cost defensive) still finds the
  aliases. New installs always write to `dridock/`.

## [3.2.2] — 2026-07-21 _(fork)_

### Changed

- **Baked `cb-*` helpers migrated to read `${DRIDOCK_X:-${CLAUDEBOX_X:-…}}`
  at every site**, so 4.0's shim removal doesn't strand them. 3.2.1's
  entrypoint aliaser papered over legacy-name reads at runtime; that
  worked but a claudebot in the wild (`51cb139f`) rightly flagged that
  4.0 (or any container path that skips the entrypoint) would silently
  regress them. All 14 legacy-name reads across the 5 baked helpers now
  prefer the canonical DRIDOCK_ name with CLAUDEBOX_ as fallback:
  - `cb-browser` (6 reads: VM_IP + HOST_CDP_URL)
  - `cb-consult` (2 reads: CONSULT_DIR + PROJECT_ID)
  - `cb-report-bug` (2 reads: FRAMEWORK_BUGS_DIR + PROJECT_ID)
  - `cb-harness-watch-consults` (3 reads: CONSULT_DIR +
    FRAMEWORK_BUGS_DIR + HARNESS_WATCH_INTERVAL)
  - `cb-host-shim` (2 reads: HOST_AGENT_URL + HOST_AGENT_TOKEN)

  `cb-browser`'s Playwright-in-a-sub-container `docker run --network host`
  now also exports BOTH DRIDOCK_ and CLAUDEBOX_ names via `-e` (the
  entrypoint's alias shim doesn't reach a sub-container that bypasses
  it). User-facing help + error strings updated to name DRIDOCK_ first.

### Added

- **Lint** in `tests/test_env_rename_compat.sh` — scans every `cb-*`
  helper for `${CLAUDEBOX_X:-…}` reads, fails if any appear without a
  sibling `${DRIDOCK_X:-` fallback (docker `-e CLAUDEBOX_X=…`
  passthrough is exempted as a legit sub-container env passthrough).
  Verified: fires on a synthetic regression (17→16 passed with 1
  intentionally-broken probe file), passes cleanly on the migrated
  tree (17/0). This is the forcing function that keeps the migration
  intact — any new bare-legacy read in a `cb-*` helper trips the build
  immediately instead of silently accumulating.

## [3.2.1] — 2026-07-21 _(fork)_

### Fixed

- **`CLAUDEBOX_*` → `DRIDOCK_*` env compat now covers container-internal reads
  too, not just host-side** (#16, framework consult
  `2026-07-21T01-31-28-unknown`). The 3.0 rebrand promised "all of 3.x accepts
  `CLAUDEBOX_*` env" but only wired the host side (wrapper's `_dridock_alias`);
  the entrypoint injected only `DRIDOCK_*` into the container, and every baked
  `cb-*` helper written before the rename (cb-browser, cb-consult, cb-report-bug,
  cb-harness-watch-consults, cb-host-shim) still reads `CLAUDEBOX_*` at each
  site. Result: `cb-browser cdp` hard-failed "no host CDP bridge" on a fresh
  3.x session even though the bridge was fully up.

  Fix: a symmetric container-side aliaser (`_dridock_alias_env` in
  entrypoint.sh), driven by the same rename map the host wrapper reads.

  - **New `env-rename.map` at repo root** — single source of truth for every
    renamed pair. 42 entries: the 36 host-facing envs the wrapper already
    aliased, plus 5 container-only ones (`DRIDOCK_VM_IP`, `DRIDOCK_PROJECT_ID`,
    `DRIDOCK_HOST_AGENT_URL`, `DRIDOCK_HOST_AGENT_TOKEN`,
    `DRIDOCK_HARNESS_WATCH_INTERVAL`) that the entrypoint injects but the
    wrapper never needed. A new rename is one line in this file.
  - **`wrapper.sh`** refactored: `_dridock_alias` now loops over the shared
    map instead of 36 hardcoded call lines. Same behavior; one file to grep.
  - **`entrypoint.sh:_dridock_alias_env`** — new function, runs AFTER
    `_load_env_sidecar` (sidecars are the durability layer; running the
    aliaser first would let a stale legacy env baked into an older
    `docker run -e` shadow an intentionally-empty sidecar entry).
    Symmetric mirror: `DRIDOCK_X` set → export `CLAUDEBOX_X`; `CLAUDEBOX_X`
    set → export `DRIDOCK_X`; both set → don't clobber; neither set → both
    stay unset.
  - **`Dockerfile`** bakes `env-rename.map` to `/usr/local/lib/dridock/`;
    **`install.sh`** copies it to `$XDG_DATA_HOME/dridock/` on the host so
    the wrapper picks it up post-install.
  - **New standard** [`docs/design/env-var-rename.md`](docs/design/env-var-rename.md) —
    documents the mechanism, sidecar-ordering rule, 4.0-removal timeline, and
    the "don't roll per-helper compat" convention. Cross-linked from
    3.0-migration.md § "Backward compat window", convenience-scripts.md, and
    the docs index.
  - **Baked `~/.claude/CLAUDE.md`** guidance gains one line noting the
    interchangeability during 3.x — prevents future claudebots from getting
    confused seeing both names in `env`.
  - **`tests/test_env_rename_compat.sh`** (new, 16 asserts) — extracts the
    aliaser function from entrypoint.sh, source-and-invokes it against a
    scratch map, and pins the symmetric-mirror semantics. Also parses the
    map file itself (every non-comment line = two shell idents) and guards
    that the critical container-only pairs are present (regression guard
    for the exact class of leak in #16).
  - **Follow-up (non-blocking, not part of this fix)**: migrate the five
    baked cb-* helpers to read `${DRIDOCK_X:-${CLAUDEBOX_X:-}}` at each
    site opportunistically, so 4.0's shim-removal doesn't strand them.

- **SessionStart consult hook now works inside a framework-dev container**,
  not only on the Mac. Pre-3.2.1 the hook (`.claude/hooks/consult-session-start.sh`)
  looked for `~/.config/claudebox/consult` and nudged `claudebox consult watch`
  — both host-only paths. Inside the container it silently exited (the consult
  dir is at `$DRIDOCK_CONSULT_DIR`, and the in-container watcher verb is
  `cb-harness-watch-consults`). Missed the 2026-07-21T01:31 consult that
  triggered #16. Hook now detects `[ -f /.dockerenv ]`, resolves both paths
  and both verbs, and nudges the correct one for the environment. Same silent
  no-op semantics when nothing is pending AND a watcher is already running.

## [3.2.0] — 2026-07-20 _(fork)_

### Changed

- **`create-react-app` is no longer baked into the `full` image, and the other
  framework scaffolders (`@vue/cli`, `@angular/cli`, `express-generator`) moved
  to a new opt-in `web-scaffolders` feature** (#14). CRA was deprecated by
  React in early 2023; keeping it baked shipped obsolete tooling to every
  claudebot. The other framework CLIs are niche enough that most projects
  don't need them baked. Anyone who wants them:

  ```bash
  dridock features enable web-scaffolders
  ```

  installs `create-vite`, `create-next-app` (the modern CRA replacements),
  `@vue/cli`, `@angular/cli`, and `express-generator` on the next boot.
  Off with `dridock features disable web-scaffolders`.

  **Not moved** (still baked, broadly useful across JS/TS projects): `eslint`,
  `prettier`, `typescript`, `typescript-language-server`, `pyright`, `ts-node`,
  `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `nodemon`,
  `pm2`, `yarn`, `pnpm`, `newman`, `http-server`, `serve`, `lighthouse`,
  `@storybook/cli`. Second non-LSP feature to ship under 3.0's features
  system (`modeguard` was the first).

  **User-visible break**: if a project's `~/.claude/init.d/` hook or claudebot
  workflow assumes any of the moved tools are on PATH, either enable
  `web-scaffolders` in that project's `.dridock/config.yml` or `npm install -g`
  the specific tool in the hook. CRA specifically has no baked replacement —
  use `npx create-vite` or `npx create-next-app` instead (recommended by React).

## [3.1.0] — 2026-07-20 _(fork)_

### Security

- **Credentials no longer travel on any command line.** Surfaced during #17, when a live
  `GH_TOKEN` appeared in ordinary `ps` output and from there in a pasted transcript. The
  harness kept secrets in 0600 files host-side — correctly — and then undid that at the
  last hop, in three places:

  | surface | who could read it | status |
  |---|---|---|
  | container argv (`/proc/1/cmdline`, mode **444**) | **any uid** in the container | fixed |
  | host argv (Mac `ps aux`, `docker run -e K=V`) | any local user, whole session | fixed |
  | `docker inspect` `Config.Env` | anything holding the docker socket | fixed |

  For contrast, `/proc/1/environ` is mode **400** (and not even root-readable in-container
  without `CAP_SYS_PTRACE`). Secrets belong in the environment, never in argv — the same
  rule `CLAUDE.md` already stated for host-side flags, now actually enforced end to end.

  - **entrypoint**: the five sidecar readers (`-auth`, `-secrets`, `-cdp`, `-vmip`,
    `-hostagent`) collapse into one `_load_env_sidecar()` that performs **real `export`s
    in the entrypoint's own shell**, instead of appending `export K=<value>` to the string
    later run as `bash -c` (which published every value in PID 1's argv). It uses
    `export "$name=$value"` with no `printf %q` and no `eval`, so a value containing shell
    metacharacters is data, never code.
  - **coverage fix, found on the way**: the loader is hoisted **above** the mode dispatch.
    The API / telegram / cron daemons `exec` before the CMD string is ever built, so the
    old CMD-string exports never reached them — those modes worked *only* because the
    wrapper also passed `-e`. Dropping `-e` without this would have silently broken
    daemon auth.
  - **wrapper**: stops passing `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
    `DRIDOCK_HOST_AGENT_TOKEN` and every `secrets.env` value via `-e`. The durable
    sidecars are now the sole channel — which they already had to be, since `docker start`
    cannot take new env. The one entrypoint-bypassing path (`dridock auth`/`mcp`, which
    runs `--entrypoint claude` and so never reads sidecars) uses a 0600 temp
    `--env-file`, putting only a *path* in argv. Empty entries are filtered out, because
    `--env-file` would turn a bare `KEY=` into a set-but-empty var that claude reads as a
    present, broken credential.
  - **tests**: guards on both halves — no non-`HOME`/`PATH` export may enter the CMD
    string, and the wrapper may not put a credential on a docker command line.

  Verified end to end on a real container: the secret still reaches the app, a value
  containing `$ ; &` and spaces arrives verbatim, an empty sidecar entry still unsets, and
  the canary is absent from `/proc/1/cmdline` read as an unprivileged `nobody`.

### Fixed

- **`KEY= value` in a sidecar exported a value with a leading space.** The loader split on
  `=` and kept every surrounding character, so one stray space after the `=` in a
  hand-edited `secrets.env` produced `GH_TOKEN=" ghp_…"` — every GitHub API call from that
  claudebot rejected, with nothing in any log explaining why. Found in the wild while
  cleaning up after the leak above: one project had been silently failing this way.
  `_load_env_sidecar()` now trims whitespace around both name and value, tolerates CRLF
  files and a final line with no newline, still splits on the FIRST `=` only (so
  `URL=https://u:p@h/x?a=b&c=d` survives intact), and skips names that aren't valid shell
  identifiers with a visible warning instead of letting `export` fail obscurely. Covered by
  executable tests that lift the real function out of `entrypoint.sh` and run it.

- **`dridock bootstrap` printed "▶ starting claudebot…" and then started nothing.** It
  re-entered the wrapper as `exec "$0"`, and bare `dridock` has printed a banner and exited
  since #12 / 2.24.0. Now `exec "$0" start`; the companion "enter later with" hint was
  wrong the same way. A test forbids verb-less self re-entry. (Seventh site of this class,
  after the six corrected in 3.0.3.)

  **Rotate any credential used with an earlier version** — assume prior `secrets.env`
  values were exposed to anything that ran `ps` on the Mac or in the container.

## [3.0.3] — 2026-07-20 _(fork)_

### Fixed

- **`--remote-control` was silently dropped: the image's Claude Code was too old**
  (#17). This is the actual root cause behind the "RC inactive" symptom that #16
  chased into the auth layer. The image pinned `ARG CLAUDE_VERSION=2.1.123`, which
  **predates Remote Control entirely** — no `--remote-control` flag, no
  `remote-control` subcommand, and a `claude doctor` that only checks the
  auto-updater. Claude Code **ignores unknown flags without erroring** (verified:
  `claude --remote-control --version` exits 0 on 2.1.123), so dridock passed the
  flag, claude discarded it, the session started clean, and RC never activated —
  with no diagnostic from any layer.

  The auth work in #16 was sound but was not what blocked Alan's case: his stored
  credential was already a full-scope claude.ai OAuth login (Max plan, including the
  `user:sessions:claude_code` scope), with both auth env vars correctly cleared.

  - **Pin bumped to `2.1.215`** (Remote Control needs `>= 2.1.206`). The pin is a
    hard floor: `DISABLE_AUTOUPDATER=1` plus the entrypoint's `.autoUpdates = false`
    patch mean a container can never update itself off it.
  - **Host-side capability check** — `dridock start --remote-control` compares the
    image's actual Claude Code version against the floor before launching and explains
    the silent-flag-drop if it's too old, instead of letting RC fail invisibly. This
    lives in `wrapper.sh`, **not** the entrypoint: probing `claude` from the entrypoint
    deadlocks PID 1 (see the tty fix below), so the entrypoint carries a comment
    warning against reintroducing it.
  - **`dridock checkversion` reports the baked Claude Code CLI version** and warns
    when it is below `CB_CLAUDE_CLI_FLOOR` (2.1.206). The CLI version is a second
    version axis, independent of the harness semver, and nothing surfaced it before —
    which is why a 92-release-stale CLI went unnoticed.

- **First container start no longer stalls 90s and then lies about it.** The default
  plugin installer (and the feature installer) ran `claude` from the entrypoint without
  redirecting stdin. PID 1 owns the container's tty, so the helper sat in a
  non-foreground process group, took SIGTTOU/SIGTTIN on first terminal access and
  stopped (ps state `T`) — `timeout` can't cleanly rescue a STOPPED process, so every
  tty-attached first start burned the full timeout and then reported
  `not installed (offline?)`, which was never true. Both call sites now pass
  `</dev/null`; measured on a tty-attached start: exit 124 (timeout) before, exit 0
  after, and time-to-session 90s+ -> 9s. The misleading "(offline?)" wording now also
  admits the timeout case. This is a **pre-existing bug**, not a 3.0.3 regression — it
  surfaced because the #17 work put a second claude invocation on the same path.

- **Stale "run `dridock`" advice corrected to `dridock start`** (6 sites). Bare
  `dridock` became info-only in #12 / 2.24.0 (prints version + hint, exits 0) but
  several messages still told users to run it to reseed a drifted project image or
  to initialize a new project — advice that silently does nothing. Includes the
  `checkversion` drift hint, which is exactly the message this release adds output
  next to.

### Docs

- `docs/design/git-and-api-auth.md` — new "Remote Control prerequisite: the baked CLI
  version" section, placed **before** the auth troubleshooting so the cheap check comes
  first. Corrected the credential path: full-scope logins land in
  `~/.claude/.credentials.json` (mode 0600), **not** `.claude.json`. Documented the
  container-specific "paste the code" OAuth fallback (the browser can't reach claude's
  local callback server from inside a container).

## [3.0.2] — 2026-07-20 _(fork)_

### Fixed

- **`--remote-control` now activatable in dridock** (#16). Anthropic gates
  Remote Control behind a full-scope claude.ai OAuth login and explicitly
  rejects setup-token-style `CLAUDE_CODE_OAUTH_TOKEN` (model-request scope
  only). Dridock defaulted to setup-token throughout, so RC silently
  refused to register even when the flag reached claude (fixed in 3.0.1).
  Three changes make RC usable:
  - **`dridock auth` passthrough now uses `-it`** — so `dridock auth login`
    (Anthropic's browser OAuth flow) can print the URL and wait for callback.
    Without a TTY, the flow couldn't complete.
  - **New env `DRIDOCK_NO_OAUTH_TOKEN=1`** — mirrors `DRIDOCK_NO_API_KEY`;
    suppresses forwarding of `CLAUDE_CODE_OAUTH_TOKEN` so a user who did
    `claude auth login` inside the container can have the stored full-scope
    credentials win over the env var (which otherwise takes precedence).
  - **Entrypoint hint**: on any interactive start where `--remote-control`
    (or `--rc`) is in the sidecar AND `CLAUDE_CODE_OAUTH_TOKEN` is set,
    print a one-liner explaining the exact fix (`claude auth login` + set
    `DRIDOCK_NO_OAUTH_TOKEN=1`). Better than "RC inactive" going unnoticed.

  Docs: new "Claude Code auth" section in `docs/design/git-and-api-auth.md`
  covering the API-key / setup-token / full-OAuth trichotomy. README's
  Authentication section adds the `--remote-control` recipe. Not needed:
  the host-agent proxy I initially feared — Anthropic's RC works fine over
  outbound HTTPS + polling, so no networking design surface here.

## [3.0.1] — 2026-07-20 _(fork)_

### Fixed

- **`dridock start <flag>` now actually forwards `<flag>` to `claude`.** 2.24.1's
  fix for `❌ Unknown flag: --remote-control` cleared the strict validator's
  rejection but left the forwarding half-done — the interactive-start path
  (both new `docker run -it` and re-attach `docker start -ai`) never passed
  user-supplied claude flags through to the entrypoint, so `dridock start
  --remote-control` (or any other flag) was silently dropped. Wrapper now
  writes remaining `$@` to a durable `.<container>-interactive-args` sidecar
  before start/create; the entrypoint's interactive branch reads it, splices
  the contents into the `claude` command line, and removes the sidecar (same
  pattern as `_prog-args` / `-no-continue` / `-update`). Covers both
  first-run `docker run` (fresh container) and `docker start -ai` (existing).
  Sidecar cleared each run so a subsequent argless `dridock start` doesn't
  inherit stale flags. Fix reported by Alan the morning after the 3.0.0 ship
  (bot in gammaray showed `claude --dangerously-skip-permissions --continue …`
  with no `--remote-control` even though the wrapper accepted the flag).

### Features

- **`modeguard` feature** (2026-07-20) — first non-LSP entry in the 3.0 features
  system. Opt-in via `dridock features enable modeguard`. Installs a
  `.git/hooks/pre-commit` in the project workspace that refuses commits which
  drop the executable bit (`100755` → `100644`) — the exact failure mode where
  Edit/Write tool paths sometimes silently strip `+x` from scripts and it lands
  in a commit unnoticed. Escape hatch:
  `DRIDOCK_MODEGUARD_ALLOW_MODE_STRIP=1 git commit …` or `--no-verify`. `on.sh`
  refuses to clobber a user-authored `pre-commit` hook (marker-detected);
  `off.sh` only removes the hook it installed. Validates the feature mechanism
  end-to-end for workspace-file-touching features (the shipped LSP features
  only touch Claude Code plugin state).

## [3.0.0] — 2026-07-20 _(fork)_

The coordinated `3.0-bundle` — four breaking-ish issues bundled as one
migration so users pay the reindex cost once. All four shipped in-master
between 2026-07-19 and 2026-07-20; see the per-issue subsections below and
the full [3.0 migration guide](docs/design/3.0-migration.md).

**Breaking / behavioral (all have backward-compat aliases for one deprecation
cycle — removed in 4.0):**
- Fork renamed `claudebox` → `dridock`. Wrapper binary, image tag/label
  (`dridock:latest`, `org.dridock.version`), env-var prefix (`DRIDOCK_*`),
  project dir (`.dridock/`), per-project data dir
  (`~/.config/dridock/projects/`), skill dir (`~/.claude/skills/dridock/`,
  slash-command `/dridock`), profiles dir (`/usr/local/lib/dridock/…`), etc.
  2.x names accepted throughout for one cycle. The `cb-*` container helper
  prefix is KEPT (descriptive "container binary," not the brand).
- `.dridock/config.yml` `features: [...]` replaces `profiles: [...]`.
- Entrypoint no longer runs `gh auth setup-git` — the credential-helper
  hijack root cause is gone. Git-over-HTTPS falls through to SSH; users
  whose `origin` was HTTPS-only must switch it to SSH or install their own
  helper.
- `bootstrap --gh-token` deprecated in favor of provider-agnostic
  `bootstrap --seed-secret KEY=CMD`.
- Baked in-container `/usr/local/bin/dridock` shim unifies the command
  surface — routes container-side verbs to `cb-*`, prints a targeted
  "run on the Mac" for host-only ones.
- Auto-migration: first `dridock` in a `.claudebox/`-only workspace
  migrates it silently (opt out with `DRIDOCK_NO_AUTO_MIGRATE=1`).
  `dridock migrate [--all]` verb for supervised / bulk migration.

**Upgrade path:** `git pull && ./install.sh` on the Mac. First `dridock` in
each existing project auto-migrates. `dridock migrate --all` pre-sweeps
every legacy project data dir under `~/.config/claudebox/projects/`.

### [#5 — features system (MVP)]

- **Landed (2026-07-20)**: `profiles:` → `features:` mechanism ship, backward-
  compat preserved, no behavior changes. New file layout
  `features/<name>/{manifest.yml, on.sh, off.sh}` (replaces flat
  `profiles/<name>.sh`) baked at `/usr/local/lib/dridock/features/`. Existing
  LSP bundles migrated: `go` / `python` / `typescript` — each declares
  `requires-bake: true` in its manifest (metadata for now; language servers
  are already baked as part of the toolchain install), gets an `off.sh` that
  uninstalls the Claude plugin. Config key rename `profiles:` → `features:` in
  `.dridock/config.yml`; both keys accepted for one deprecation cycle. New
  host CLI `dridock features [list | enable <name> | disable <name> | info
  <name>]` — `enable` rewrites the config's `features:` block (portable
  temp-file rewrite, not sed -i); `disable` also clears the enable marker in
  the project's data dir and best-effort runs `off.sh` in the running
  container. `dridock profiles` remains as a legacy alias with a one-line
  deprecation notice. Entrypoint reads new `~/.claude/.features` sidecar
  first, `~/.claude/.profiles` as fallback; recognizes both `.feature-<name>`
  and `.profile-<name>` enable markers so 2.x projects don't re-run
  installers on 3.0's first boot. Container-side `dridock` shim (#1) knows
  about the new `features` verb. Old `profiles/` source dir removed (replaced
  by `features/`). CLI + config exercised end-to-end (enable, enable-again
  idempotent, disable, legacy `profiles:` key read). Full design ADR in
  [docs/design/features-system.md](docs/design/features-system.md); deferred
  items listed there (machine-wide `default_features:`, project-local
  `.dridock/features/`, converting SSH-git / browser-bridge / host-agent to
  features).

### [#1 — unify host↔container command surface]

- **Landed (2026-07-20)**: baked `/usr/local/bin/dridock` shim in the
  image (route: `dridock consult|report-bug|browser|df|help` → the same
  `cb-*` implementation; host-only verbs like `start|stop|vm|ip|net|
  bootstrap|migrate|checkversion|…` exit 2 with a targeted "run this on
  your Mac: `cd $DRIDOCK_WORKSPACE && dridock <verb>`" message instead
  of a generic "unknown command"). Both names work everywhere; `cb-*`
  stays canonical (referenced in help/docs/headers), `dridock <verb>` is
  the reflex-consistent alias with the host CLI. Also bakes a
  `/usr/local/bin/claudebox → dridock` symlink for one deprecation cycle
  (2.x binary-name muscle memory). `cb-help` mentions the unified alias;
  docs/design/convenience-scripts.md updated with the split rationale.

### [#10 — split git-vs-API auth]

- **Follow-up (2026-07-20)**: fresh-container SSH host-key verification.
  With the credential-helper gone, first-connect `git pull|push` against a
  git host hit `StrictHostKeyChecking` on an empty `known_hosts` and
  failed with "Host key verification failed" — the exact symptom Alan hit
  on the first restart. Entrypoint now pre-seeds `~/.ssh/known_hosts` with
  the majors (github.com, gitlab.com, bitbucket.org, codeberg.org) via
  `ssh-keyscan` once per container (versioned stamp), and appends
  `Host * / StrictHostKeyChecking accept-new` to `~/.ssh/config` as the
  catch-all for self-hosted / less common providers. Both writes land in
  the bind-mounted `~/.ssh/` so they persist across restarts. Idempotent:
  re-runs don't duplicate the config block or re-scan the majors.
- **Landed (2026-07-19)**: SSH-for-git, tokens-for-API-only. Entrypoint no
  longer runs `gh auth setup-git` on start — the credential-helper hijack
  root cause is gone. Git-over-HTTPS falls through to SSH via
  `~/.ssh/claudebox/id_ed25519` (path kept for one cycle); one keypair covers
  every provider a user pushes to. `bootstrap` grows a provider-agnostic
  `--seed-secret KEY=CMD` flag (repeatable): runs `CMD` on the host, writes
  stdout as `KEY` in `.dridock/secrets.env` — trimming whitespace so
  `gh auth token`'s leading-space quirk doesn't corrupt the value.
  `--gh-token` is kept as a deprecated alias for `--seed-secret
  GH_TOKEN='gh auth token'` through 3.x. New standard:
  [`docs/design/git-and-api-auth.md`](docs/design/git-and-api-auth.md).
  Behavior break for anyone whose `origin` was HTTPS and relied on the baked
  credential helper — set it to SSH (`git remote set-url origin
  git@…:owner/repo.git`) or install your own helper. `install.sh` prose
  un-softened to point users at SSH for git and per-provider tokens for API.

### [#11 — dridock rebrand]

- **Phase 1 (2026-07-19)**: design decisions locked in
  `docs/design/3.0-migration.md`. Kept: `cb-*` container helpers, `cb-<id>` colima
  profiles, `cb-net`, container name derivation, sidecar file naming, `~/.claude`
  paths. Renamed: env-var prefix, image tag/label, project dir, per-project data dir,
  wrapper binary default, skill dir. Backward-compat for one deprecation cycle
  (`CLAUDEBOX_*` env accepted, `.claudebox/` dir read as fallback, both wrapper.sh
  fingerprint patterns honored).
- **Phase 3 (2026-07-19)**: image tag / label / binary defaults renamed.
  `IMAGE_NAME` default in `Makefile` + `install.sh` flipped `claudebox` → `dridock`
  (image tag becomes `dridock:latest`). `LABEL org.claudebox.version` in `Dockerfile`
  renamed to `org.dridock.version`. `cb_image_status` in `wrapper.sh` reads
  `org.dridock.version` primarily and falls back to `org.claudebox.version` for one
  cycle — so `checkversion` on a 3.0 wrapper against a 2.x image shows the version
  instead of "unstamped." `BIN_NAME` default in `install.sh` flipped `claudebox` →
  `dridock` (wrapper binary installed as `~/.local/bin/dridock`). Wrapper's
  `CLAUDE_IMAGE_NAME` default renamed alongside. Existing installs need to
  reinstall (`./install.sh`) and rebuild (`make build`) to pick up the new tag and
  binary name.
- **Phase 4b (2026-07-19)**: `dridock migrate` verb + auto-migrate. Three
  idempotent helpers move the three layers of 2.x state to the 3.0 layout —
  `cb_migrate_workspace` (project's `.claudebox/*` → `.dridock/*` + rewrite
  `/.claudebox/…` lines in `.gitignore`), `cb_migrate_data_dir` (per-project
  `~/.config/claudebox/projects/<id>/` → `~/.config/dridock/projects/<id>/`),
  `cb_migrate_machine_config` (`~/.config/claudebox/config.yml` → dridock's).
  New verb `dridock migrate` runs the first three for the current project +
  the machine config; `dridock migrate --all` also walks every legacy project
  data dir under `~/.config/claudebox/projects/`. Auto-migrate on the first
  `dridock` invocation in a `.claudebox/`-only project handles the common
  case silently (one info line printed); opt out with
  `DRIDOCK_NO_AUTO_MIGRATE=1`. New `cb_xdg_dir()` helper flips the machine
  config path + baked `data_root` default to prefer `~/.config/dridock/`
  when it exists, falling back to `~/.config/claudebox/` for one cycle. Full
  unit coverage in `tests/test_cbconfig.sh` (workspace + data-dir + machine-
  config migrations, idempotency, gitignore rewrite preserves unrelated
  lines, secrets mode preserved).
- **Phase 4 (2026-07-19)**: project-dir rename `.claudebox/` → `.dridock/`. New
  `cb_project_dot()` helper returns `.dridock` when it exists, `.claudebox` when
  only the legacy dir exists, otherwise the new `.dridock` default — so writers
  route to `.dridock/` on fresh projects while existing 2.x projects keep working
  from `.claudebox/`. `cb_project_config_path`, `cb_secrets_path`,
  `cb_brief_path`, `cb_write_sample`, `cb_init_project_config`, `cb_bootstrap`
  all use it. `cb_ensure_gitignore` writes BOTH `/.dridock/config.yml` +
  `/.dridock/secrets.env` AND the legacy `/.claudebox/*` entries (dedup'd), so a
  workspace opened by either a 2.x or 3.0 wrapper stays clean. Guard predicate
  `cb_in_dotclaudebox` recognizes both `.dridock` and `.claudebox` subpaths;
  `cb_guard_workspace` strips whichever suffix it finds. Entrypoint's baked
  guidance / brief lookup / plugin-marker check the new location first, fall
  back to legacy. Wrapper user-facing messages and `dridock` command names
  updated in the strings that don't need dynamic dot resolution. Tests +
  examples updated to the new dotname.
- **Phase 2 (2026-07-19)**: env var rename `CLAUDEBOX_*` → `DRIDOCK_*` across
  `wrapper.sh` + `entrypoint.sh` + `Dockerfile` + `Makefile`. Wrapper adds a
  `_dridock_alias` compat block at the top that copies every user-supplied
  `CLAUDEBOX_X` value into `DRIDOCK_X` if the new name isn't set — so all in-file
  reads use `DRIDOCK_X` uniformly while legacy invocations continue to work.
  Prefix-based iterations (`ENV_*`, `MOUNT_*`) accept both prefixes inline
  (`DRIDOCK_ENV_*` + `CLAUDEBOX_ENV_*` + `CLAUDE_ENV_*`, similarly `MOUNT_`).
  Framework-dev fingerprint accepts wrapper.sh containing either
  `^DRIDOCK_VERSION=` or `^CLAUDEBOX_VERSION=` for one cycle.
  Wrapper injects only `DRIDOCK_X` names via `-e` — the entrypoint reads only
  `DRIDOCK_X` from container env; the CLAUDEBOX-side aliases are host-wrapper-only.
  ~30 env vars renamed; docs at `docs/environment-variables.md` stay on old names
  until Phase 5's docs pass.

## [2.24.1] — 2026-07-19 _(fork)_

### Fixed
- **`claudebox start --any-flag` no longer errors with "❌ Unknown flag".** Regression
  from 2.24.0's `start` verb: after `start` shifted off, the `$@` reached the strict
  `-p` programmatic-mode arg validator, which enforces a fixed allowlist
  (`-p`/`--print`/`--output-format`/`--model`/…). Any flag outside that list — e.g.
  `claudebox start --remote-control` — got rejected before the code even decided
  whether we were in programmatic mode.
  Fix: pre-scan `$@` for `-p`/`--print`; if absent, skip the strict validator
  entirely and let every arg pass through to interactive `claude` unchanged. The
  validator still applies to genuine `-p` invocations. Reported by Alan; affected
  `claudebox start --remote-control` and `claudebox start -- --remote-control`.
  Host-only (wrapper.sh); no image rebuild.

## [2.24.0] — 2026-07-19 _(fork)_

### Changed (user-visible CLI break)
- **Bare `claudebox` (no args) no longer starts the claudebot.** Now prints the
  wrapper version + a two-line start hint. Rationale: reduces accidental container
  starts from muscle-typing `claudebox` in the wrong dir (a partial mitigation on
  top of 2.15.4's new-project guard), and matches the reflex-inspection habit for
  most CLIs (bare-name = info). Closes #12.
- **`claudebox start`** — new verb; runs what bare `claudebox` used to do
  (start/attach the interactive claudebot for `$PWD`; passes through `-p` + claude
  args unchanged). Explicit-verb requirement is the whole point.

  Migration for muscle-typed workflows: reflex `claudebox` → `claudebox start`.
  Explicit-arg forms (`claudebox -p "..."` etc.) are unaffected — those DO now
  require `start` in front (`claudebox start -p "..."`); pipelines / aliases will
  need updating.

### Added
- **`claudebox completion bash`** — emits a bash completion script for the wrapper's
  current binary name (`$(basename $0)` so `CLAUDEBOX_BIN_NAME=dridock` reinstalls
  get a `_dridock_complete` bound to `dridock`). Completes top-level verbs at word 1
  and sub-verbs / flags at word 2 (`vm ls|usage|gc`, `harness sync [--repair]`,
  `checkversion [--all]`, `consult list|show|approve|watch|revise|reject|post`,
  `browser-bridge up|down`, `host-agent up|down|status`, `framework-bugs list|clear`,
  `bootstrap` flags, `destroy [--purge]`, `start` claude-args). Closes #13.
- **`install.sh`** now runs `claudebox completion bash` and drops the output into
  `${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions/<binname>` —
  the XDG-standard path bash-completion auto-loads. Prints a hint if bash-completion
  isn't detected (brew/port/system pkg paths checked). zsh users with `bashcompinit`
  loaded pick this up too; a native zsh completion is a separate ask.

Host-only (wrapper.sh + install.sh) — no image rebuild needed; reinstall the wrapper
to pick it up.

## [2.23.0] — 2026-07-19 _(fork)_

### Added
- **`cb-consult post <id> --author <name> [--status <state>]`** — the missing framework-
  Claude authoring verb. Replaces the direct-Write-tool + `sed`-edit-meta workaround the
  `framework-consult` skill has been using for framework replies. Body on stdin; adds a
  turn as the named author (so replies land as `NNN-framework.md` instead of
  `NNN-claudebot.md`); optionally flips `meta.status` in one call. Mirrors the host
  `claudebox consult post` verb name for consistency. SKILL.md updated with both
  in-container and host recipes. Closes #2.
- **`claudebox checkversion --all`** — cross-project image inventory. Existing
  `checkversion` shows wrapper vs cb-infra vs the current project's image; `--all`
  additionally enumerates every other `cb-*` project VM's image version, so drift is
  visible across the whole install. Read-only, same "never boots a VM" semantic as
  bare `checkversion`. Closes #6.

### Fixed
- **`browser-bridge up`: fresh window hash per bridge session** (not stable across
  reboot). Previously the 8-hex `window-hash` file was persisted across `down` /
  restart, so a Mac reboot → new Chrome launch reused the same hash. Now the hash is
  regenerated whenever the pids file is missing or points at dead processes (Mac
  reboot, VM restart, Chrome closed) — i.e. whenever we're actually launching a new
  Chrome. A second `up` while the bridge is still running reuses the current hash (so
  the printed identity matches the window that's actually open). Closes #3.

Host-only (wrapper.sh) + baked helper (cb-consult). **cb-consult change needs
`make build`**; the wrapper changes take effect on the next `install.sh` reinstall
without a rebuild.

## [2.22.0] — 2026-07-17 _(fork)_

### Added
- **`cb-harness-watch-consults`** — in-container mirror of host `claudebox consult
  watch`, scoped to framework-dev needs: blocks until any cross-project consult enters
  `awaiting-framework` (a new thread OR a fresh `cb-consult say` turn on an existing
  awaiting-framework thread) OR any new unreviewed framework-bug report appears. Prints
  what changed, exits. Run as a background task from a framework-dev session; the
  harness re-invokes on exit; handle the change; relaunch to keep watching. Closes the
  mid-session-alert gap that let gammaray's consult `2026-07-17T01-36-41-51cb139f` sit
  unnoticed for hours. Default poll 20s (arg or `$CLAUDEBOX_HARNESS_WATCH_INTERVAL`).
  **First application of the `cb-harness-<name>` convention** established in
  `docs/design/framework-dev-mode.md` (`c717031`). Also referenced from the
  `framework-consult` skill so future framework-Claude sessions launch it as a
  background task. Closes #7.

### Changed
- **Renamed `CLAUDEBOX_FRAMEWORK_DEV` → `CLAUDEBOX_HARNESS_DEV`** to match the
  `harness` naming convention established in 2.20.0 (`claudebox harness <verb>`,
  `cb-harness-<name>`, `cb_harness_<verb>`). Backward-compat: the legacy name is still
  honored as an alias — same pattern as `CLAUDE_* → CLAUDEBOX_*`. Fixes a latent
  inconsistency: the env override was honored in `entrypoint.sh` but NOT in
  `wrapper.sh`'s `cb_is_framework_dev`, so a renamed/relocated fork got startup
  surfacing but not the `claudebox harness` commands. Both now check the env, and
  `cb_is_framework_dev` is the single source of truth (called from both files).
- **New env-var naming convention** documented in
  `docs/design/framework-dev-mode.md` — `CLAUDEBOX_HARNESS_*` for framework-dev-mode
  env; `CLAUDEBOX_HARNESS_WATCH_INTERVAL` is the second in the family.

**Needs `make build`** (new baked helper + entrypoint change); rebuild auto-recreates
containers.

## [2.21.1] — 2026-07-17 _(fork)_

### Fixed
- **`cb-browser cdp` / `cb-browser script-cdp` fail on the second run of a session**
  with `browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior):
  Browser context management is not supported.` Root cause: Playwright's
  `connectOverCDP` falls through to a browser-level `Browser.setDownloadBehavior`
  call when the debug Chrome has zero page targets at attach time (stock Chrome
  rejects that API — it's a Playwright-owned-Chrome-only knob). And 2.17.0's
  `script-cdp` snapshot-diff cleanup guarantees zero page targets after any run
  whose script opened all its own tabs from an empty starting state. First run of
  a session works (welcome tab exists); subsequent runs fail until the human
  manually opens a tab. Fix: new `_cdp_ensure_page` helper in `cb-browser` —
  `PUT /json/new?about:blank` (with GET fallback for pre-v100 Chrome) when
  `/json/list` shows zero page targets, before Playwright attaches. Wired into
  both `script-cdp` (fires BEFORE the `_pre` snapshot so the warm-up tab is
  inside `_pre` and cleanup preserves it across runs — no accumulation) and
  `cdp` (fires before the `docker run` — no snapshot there to interact with).
  Diagnostic log if the warm-up itself fails so the failure mode is obvious
  instead of Playwright's cryptic error. Resolves gammaray consult
  `2026-07-17T01-36-41-51cb139f`. **Needs `make build`** (`cb-browser` +
  entrypoint guidance); rebuild auto-recreates containers.

## [2.21.0] — 2026-07-16 _(fork)_

### Added
- **`claudebox harness sync --repair`** — automatic recovery from BuildKit snapshotter
  corruption. That corruption (`failed to prepare extraction snapshot ... parent
  snapshot ... does not exist`) is rare-but-real (interrupted build, prune racing with
  a build, an upgrade across BuildKit versions); the manual recovery is always
  `docker builder prune -af` + retry, and now the harness wraps it. `--repair` runs
  `make build` as normal; if it succeeds, we're done. If it fails, the wrapper greps
  stderr for the specific corruption pattern — matches → auto-prunes cb-infra's build
  cache and retries once; no match → surfaces the error and exits (won't nuke the
  cache for unrelated failures like a Dockerfile syntax error or an apt-get network
  timeout). Concrete case that motivated this: Alan hit the corruption after four days
  of harness iteration and had to run the exact `builder prune -af` + retry sequence
  manually. Now it's one flag. Costs ~10-20 min extra for a cold-start rebuild when it
  fires — same cost as the manual recovery, just no keyboard mash. Host-only (wrapper)
  — **no image rebuild needed**; reinstall the wrapper to pick it up.

## [2.20.2] — 2026-07-16 _(fork)_

### Fixed
- **`cb-consult` `_post` numbering race.** Two concurrent writers on the same thread
  (e.g. framework-Claude posting a reply and the claudebot running `cb-consult
  resolve` in the same second) both computed the same "next" turn number from
  `find ... | wc -l` and produced e.g. `004-framework.md` + `004-claudebot.md`
  (different author suffixes, so no clobber — but breaks chronological ordering).
  Hit this twice in a single session working gammaray's consults; renamed to `005`
  manually both times. Fix: `_post` now serialises the count+write inside a
  per-thread `flock` on `<thread>/.post-lock`. Verified with 10 concurrent writers
  → sequential 001–010, zero collisions. **Needs `make build`** (baked helper);
  rebuild auto-recreates containers.

## [2.20.1] — 2026-07-16 _(fork)_

### Fixed
- **cb-infra BuildKit cache no longer grows unbounded across rebuilds.** The Makefile's
  `build` and `build-minimal` targets already ran `docker image prune -f` after each
  build to reclaim the previous `claudebox:latest` (now dangling after retag), but they
  did **not** prune BuildKit cache — so cache from every intermediate stage
  (`apt-get`/`npm i`/`pyenv install`/etc.) accumulated forever. Concrete: after four
  days of harness iteration (2.15.4 → 2.20.0, seven versions + interim experiments),
  Alan's cb-infra had **41 GB** of stale build cache, which only came out via a
  nuclear `docker builder prune -af` (which also wiped the useful cache and forced a
  ~10-20-min next-build cold-start). Fix: Makefile now also runs `docker builder prune
  -f` (non-`-a`, dangling cache only, so recently-used layers survive) after each
  build. Same shape as the existing `image prune -f`, and mirrors what 2.15.3 did for
  project VMs via `CLAUDEBOX_PRUNE_ON_START`. Repo-only (Makefile) — **no image
  rebuild needed**, no wrapper reinstall; the next `make build` picks up the new
  behavior.

## [2.20.0] — 2026-07-16 _(fork)_

### Added
- **`claudebox harness <verb>`** — a namespace for framework-dev-only commands, gated by
  the framework-dev fingerprint (workspace's `wrapper.sh` at root contains
  `CLAUDEBOX_VERSION=`). Listed in `--help` with a "framework-dev:" tag (same pattern as
  `host-agent`'s TRUSTED tag) so non-dev users see it, register it as not-for-them, and
  skip past. Running a `harness` verb from a non-harness workspace (e.g. from gammaray)
  errors clearly with "$root is not a claudebox harness fork" rather than doing something
  surprising. First verb:
  - **`claudebox harness sync`** — rebuild cb-infra's `claudebox:latest` from the current
    wrapper checkout (thin wrapper around `make build`). Correction side of the 2.19.0
    drift warning: once the wrapper tells you cb-infra is behind, this is the one command
    to bring it forward. In-container guard: refuses to run from inside a container
    (docker backend would build on the container's own VM, NOT cb-infra) and prints the
    exact Mac command to run instead.
- Refactor: extracted `cb_is_framework_dev` helper (was inlined in 2.19.0's
  `cb_check_infra_drift`); now shared by the drift check + the new `harness` gate.

Host-only (wrapper.sh) — **no image rebuild needed**; reinstall the wrapper to pick it up.

## [2.19.0] — 2026-07-16 _(fork)_

### Added
- **`claudebox` warns on every invocation when `cb-infra` image is behind the wrapper.**
  A latent gap the framework-dev-inside-a-claudebox workflow exposed: since 2.15.0's
  `CLAUDEBOX_BACKEND=docker` auto-detect, `make build` from inside a framework-dev
  claudebot builds on the project's own VM daemon — **not** on `cb-infra`. So while the
  wrapper's `CLAUDEBOX_VERSION` marches forward with each release, `cb-infra` keeps
  whatever version was there when it was last built from the Mac. Fresh project VMs
  reseed from `cb-infra` → they silently inherit the stale image. `claudebox
  checkversion` catches this if run explicitly, but drift accumulates invisibly
  otherwise. Concrete: six releases 2.15.4 → 2.18.0 shipped in one session with
  `cb-infra` untouched; other projects would have gotten the old image on next reseed.
  Now `claudebox` runs a fast cb-infra image inspect (silent if cb-infra is down or the
  image is unstamped) and prints a one-line severity-classified warning on drift:
  - 🔴 MAJOR — rebuild REQUIRED (breaking IPC-contract change)
  - 🟠 MINOR — SHOULD rebuild (additive contract change / new features)
  - 🟡 PATCH — rebuild optional (fixes/docs only)
  Auto-skipped for the framework-dev workspace itself (fingerprint: `wrapper.sh` at
  root containing `CLAUDEBOX_VERSION=` — the person iterating there IS the one causing
  drift). Silenceable via **`CLAUDEBOX_NO_DRIFT_WARN=1`** for scripted / CI contexts.
  Never blocks — always a warning; fires on the same allowlist as the workspace + new-
  project guards (skipped for `setup-token`, `-v`, `--version`, `doctor`, `auth`,
  `mcp`, `stop`, `clear-session`). Host-only (wrapper) — **no image rebuild needed**;
  reinstall the wrapper to pick it up.

## [2.18.0] — 2026-07-16 _(fork)_

### Added
- **CDP debug Chrome window is named "Claudebox Chrome -- `<hash>`".** `claudebox
  browser-bridge up` now launches Chrome with a data-URL welcome tab whose `<title>`
  is `"Claudebox Chrome -- <hash>"` (8-hex-digit instance hash from `/dev/urandom`,
  persisted to `~/.config/claudebox/cdp/window-hash` so a subsequent `up` reuses the
  same hash; wiped by `down` so the next `up` gets a fresh one). macOS Chrome's window
  title mirrors the active tab's title, so the debug window is now identifiable at a
  glance in Mission Control / Cmd+Tab / Dock tooltip — no more "which of these Chrome
  windows is claudebot's?". The welcome message also prints the full window title so
  you can grep for it. Tradeoff (documented): if you navigate the welcome tab, the
  title changes with it — reopen the welcome URL (or the tab) to get the marker back.
  `--app`-mode was rejected as an alternative because it strips the tab strip / URL bar
  / DevTools, which defeats the point of interactive debugging.

Host-only (wrapper.sh) — **no image rebuild needed**; reinstall the wrapper (`install.sh`)
to pick it up.

## [2.17.1] — 2026-07-16 _(fork)_

### Fixed
- **Claudebot never prompts for permission again.** The runtime flag
  `--dangerously-skip-permissions` is passed on every `claude` invocation, but it isn't
  fully authoritative in newer Claude Code — certain operations (notably writes under
  `~/.claude/`) still surface a permission prompt. Concrete case: a gammaray session
  paused mid-work to ask for `mkdir -p ~/.claude/bin`. The claudebox model is that the
  container **is** the sandbox — Claude should never prompt inside it. Fix: the entrypoint
  now also persists `.permissions.defaultMode = "bypassPermissions"` into
  `~/.claude/settings.json` on every container start (jq-merge if the file exists, seed if
  it doesn't). This makes bypass mode the *persistent* default alongside the runtime flag,
  and self-heals if an accidental UI toggle changes it — the next boot rewrites it.
  **Needs `make build`** (entrypoint change); rebuild auto-recreates existing containers.

## [2.17.0] — 2026-07-16 _(fork)_

### Added
- **`cb-browser script-cdp <file.cjs>`** — Approach-B's `script`: a dedicated CDP-aware
  subcommand for custom Playwright flows against the human's real Chrome. Resolves
  gammaray consult `2026-07-16T15-12-59-51cb139f` (CDP tab-lifecycle standard) and
  closes an untriaged framework gap: `cb-browser script` is A-only (cb-net, headless,
  no CDP env forwarded), but the docs implicitly recommended it for custom CDP flows —
  which meant claudebots either rolled their own `docker run -e CLAUDEBOX_HOST_CDP_URL
  --network host …` (defeating the point of `cb-*` helpers) or hit an obscure
  connection failure. `script-cdp` closes that gap end-to-end:
  - Requires the CDP bridge (`claudebox browser-bridge up`); errors clearly if down.
  - Forwards `CLAUDEBOX_HOST_CDP_URL` (both under its full name and as `$CDP_URL`) plus
    `CLAUDEBOX_VM_IP`; uses `--network host` so the container reaches
    `192.168.64.1:9223` over `col0`.
  - **Tab-leak safety net.** Snapshots page targets on the debug Chrome via
    `/json/list` before the script runs; on exit (any status, incl. `SIGINT`/`SIGTERM`)
    closes any *new* page targets whose ids weren't in the pre-snapshot. So the
    natural Playwright pattern (`connectOverCDP → newPage → browser.close`) can't
    leak tabs — `browser.close()` alone only detaches CDP, the tab lives on until an
    explicit `page.close()`. Filter is `type === "page"`, so service workers,
    iframes, background pages, and workers are never touched. Opt-out:
    **`CB_BROWSER_CDP_KEEP=1`** (env — a flag would collide with pass-through
    `args...`).
  - **Assumption (baked into the design):** the debug Chrome is a dedicated profile
    (per `docs/design/browser-testing.md` § "B security"), so the human isn't doing
    casual browsing there. A tab the human opens in the debug profile mid-run is
    included in "opened during the run" and will be closed on cleanup — this is
    acceptable because that's precisely what "dedicated" means.
- **`docs/design/browser-testing.md`** gains a new "Custom CDP flows:
  `cb-browser script-cdp`" subsection under Approach B (canonical `try/finally` +
  `page.close` snippet, the `$CLAUDEBOX_VM_IP:<port>` addressing pattern for hitting
  in-VM workloads from a host-networked container, and the opt-out). The A1 section
  now explicitly marks `cb-browser script` as A-only. The "Prefer `cb-browser cdp` /
  `script-cdp` over a hand-rolled `connectOverCDP`" paragraph now warns against
  reproducing `connectOverCDP` under `cb-browser script`. Phased-plan gains item 6.
- **Baked container guidance** (`entrypoint.sh`) gains a "Custom CDP script? Use
  `cb-browser script-cdp`, NOT `cb-browser script`" bullet under CDP gotchas, and the
  A1 `script` bullet is marked A-only with a pointer to `script-cdp`.
- **`docs/environment-variables.md`** gains a "Container-side `cb-browser` knobs"
  section documenting `CB_BROWSER_*` (previously undocumented — the whole family) and
  the new `CB_BROWSER_CDP_KEEP`.

No new sidecar files, no new host↔container env-forwarding schema, no marker — pure
additive baked-helper surface + docs. **Needs `make build`** (`cb-browser` +
entrypoint changes); rebuild auto-recreates existing containers.

## [2.16.1] — 2026-07-16 _(fork)_

### Changed
- **Baked guidance now leads with a framework-vs-project check.** New section in
  `~/.claude/CLAUDE.md` (generated by `entrypoint.sh` on every container start), placed
  immediately before the two escalation channels ("Reporting a bug in the claudebox
  FRAMEWORK" and "Escalating a framework BEST-PRACTICE question"), that asks a claudebot
  at write-time: does the rule I'm about to write name any code/schema/service that
  belongs to *this* project? If no, it's a framework rule and belongs upstream via
  `cb-report-bug` (concrete defect / doc gap) or `cb-consult open` (best-practice
  question) — not in the project's own `CLAUDE.md`. Signals + keyword list demoted to
  illustration (the positive test is authoritative so it doesn't rot as new `cb-*`
  helpers get added). Resolves gammaray consult `2026-07-16T15-12-41-51cb139f`; the
  triggering incident was a page-close-in-finally rule that mislabeled a framework
  concern (`cb-browser script` CDP tab lifecycle) as a project rule and would never have
  propagated. Companion doc pointers added to `docs/design/framework-consult.md` and
  `docs/design/framework-bug-reporting.md`. **Needs `make build`** (entrypoint change);
  rebuild auto-recreates existing containers.

## [2.16.0] — 2026-07-16 _(fork)_

### Added — framework-Claude in-container review surface
- **Startup surfacing for framework-dev claudebots.** A claudebot developing the harness
  itself from *inside* a container had no visibility onto framework-bug reports or consults
  that OTHER projects had filed and were awaiting a framework draft — the review flow was
  designed assuming framework-Claude worked on the Mac via `claudebox consult list` /
  `claudebox framework-bugs list`, but those are host wrapper commands and not reachable
  from inside a container. Concrete miss: a session working on this repo had no idea
  gammaray had filed 2 consults + 1 bug earlier the same day. Now the entrypoint detects
  when the workspace **is** a claudebox harness fork (`wrapper.sh` at its root containing
  `CLAUDEBOX_VERSION=` — a very specific fingerprint; override with
  **`CLAUDEBOX_FRAMEWORK_DEV=1`**) and injects a startup note listing every consult with
  `status=awaiting-framework` (across ALL projects) plus every framework-bug report not
  yet marked `.reviewed`, pointing at the two new in-container commands below. Skipped for
  every normal claudebot.
- **`cb-consult list --all`** — cross-project consult listing (framework-dev view). The
  default `cb-consult list` still filters to this project's threads only; `--all` widens
  it to every project and includes the project id column, matching what host
  `claudebox consult list` shows.
- **`cb-report-bug list|show|done`** — the missing management surface for the
  file-drop bug reports. `list` prints every bug in the shared drop dir (marking those
  with a `.reviewed` sidecar `✓`); `show <slug>` prints the report body; `done <slug>`
  drops a `.reviewed` sidecar so the framework-dev startup surfacing hides it from the
  "unreviewed" count. The historic filing form (`cb-report-bug "<title>" ... <<EOF`) is
  unchanged — subcommands are only recognized as the FIRST arg.

Together these mean a framework-dev claudebot working on this repo (or any renamed fork)
picks up waiting review work on every session start, instead of only when a human tells
it. Env-var + doc updated. **Needs `make build`** (entrypoint + baked helpers); the
rebuild auto-recreates existing containers.

## [2.15.4] — 2026-07-15 _(fork)_

### Added
- **Guard against silently spinning up a fresh project in some random dir.** Running
  `claudebox` in a dir without `.claudebox/config.yml` used to silently create the
  config (and, on the next step, a per-project Colima VM that reserves CPU/RAM/disk
  and takes ~30-60s to boot) — trivially triggered by a mistyped `cd`, a wrong
  terminal, or a scratch dir. Now the wrapper detects it and prompts
  (`Create a new claudebox project at this path? [y/N]`), suggesting
  `claudebox bootstrap "<intent>"` as the proper way to start a new project. In
  non-interactive mode it aborts (safer for CI/scripts). Override with
  **`CLAUDEBOX_ALLOW_NEW=1`**. Follows the 2.5.1 subdir-guard pattern; skipped for the
  same allowlist of throwaway/utility commands (`setup-token`, `-v`, `--version`,
  `doctor`, `auth`, `mcp`, `stop`, `clear-session`). `bootstrap` self-heals via its
  re-exec (creates `.claudebox/` first, then re-enters). Host-only — **no image
  rebuild needed**; reinstall the wrapper to pick it up.

## [2.15.3] — 2026-07-13 _(fork)_

### Changed
- **`CLAUDEBOX_PRUNE_ON_START` now also prunes dangling images**, not just build cache. The
  opt-in prune ran `docker builder prune -f` only, so an untagged image orphaned when a
  rebuild retagged `claudebox:latest` (routine on harness-dev projects that `make build`
  often) would linger — one such image on the dev VM was ~1.7 GB of unique layers, invisible
  to `docker images` and only visible via `docker system df`'s "reclaimable". Now the same
  opt-in also runs `docker image prune -f` alongside. Best-effort and safe — `image prune -f`
  only touches untagged unreferenced images (never a tagged image, never a running
  container's image). Env-var + doc updated. `vm gc` (Mac-side) has always covered this;
  this closes the same gap on the container side. **Needs `make build`** (entrypoint change).

## [2.15.2] — 2026-07-12 _(fork)_

### Changed
- **Dockerfile layer caching — releases and script edits no longer rebuild the toolchain.**
  `full` is `FROM base`, so the two frequently-changing things that lived in `base` — the
  `CLAUDEBOX_VERSION` ARG/ENV/LABEL (near the top, bumped every release) and the harness
  `COPY`s + `CHANGELOG.md` (at the end of base, change nearly every commit) — invalidated
  full's entire Go/npm/pyenv/pip toolchain on every build, making a version bump or a one-line
  script edit a ~10–20 min rebuild. Moved both into a cheap `harness` staging stage that each
  variant `COPY --from`'s in — with the version stamp — at the very END, after the toolchain.
  Now a release rebuilds only the tail ENV/LABEL and a script/CHANGELOG edit only the three
  final `COPY --from=harness` layers; the toolchain stays cached (verified on cb-infra: 0 npm
  reruns). **Build-time only** — the resulting image is behaviorally identical, so existing
  users need **no rebuild**. One-time cost: the next `make build` re-establishes `base`'s layers.

## [2.15.1] — 2026-07-13 _(fork)_

### Fixed
- **`CLAUDEBOX_VM_IP` was empty on first-run cold boot.** The wrapper's IP-injection block
  ran BEFORE `cb_ensure_vm`, so on a brand-new VM the lookup raced `colima start
  --network-address` (col0 reachability lags by a couple of seconds) — the env never got
  set, the sidecar was written empty, and the fresh container came up without the address
  its browser tier / CORS logic needs. Only self-healed on the NEXT `claudebox` run once
  the VM was already up. Fixed by moving the injection into `cb_ensure_vm` itself (new
  `cb_inject_vm_env` helper) and switching to `cb_wait_reachable` so col0's boot lag is
  handled. Host-only — no image rebuild, no IPC contract change (sidecar name/format and
  env-var names unchanged).

## [2.15.0] — 2026-07-12 _(fork)_

### Added
- **Backend-aware build + test (`CLAUDEBOX_BACKEND`)** — task #15 Approach 2 **phase 3**, resolved
  as "docker LOCAL, not proxied." A `docker` shim proxying to the Mac was rejected (near-full host
  compromise — `docker run -v /:/mac` on the Mac — for little gain). Instead `make build` and
  `tests/common.sh` now branch on `CLAUDEBOX_BACKEND` (`colima` | `docker`, auto-`docker` when
  `/.dockerenv` exists): in `docker` mode they build the image and run the integration tests on the
  **ambient daemon** (the dev claudebot's own VM), with no colima and no host proxy. So a claudebot
  developing this harness inside a container can `make build` + `bash test.sh` end-to-end. The
  phase-1 `host-agent` remains only for the narrow slice that needs *real* Colima (e.g. exercising
  `claudebox vm gc` against live VMs). Override: `make build CLAUDEBOX_BACKEND=docker`,
  `CLAUDEBOX_BACKEND=docker bash test.sh`. Design: [docs/design/backends.md](docs/design/backends.md).

Repo-only (Makefile / test harness) — **no image rebuild needed**.

## [2.14.0] — 2026-07-12 _(fork)_

### Added
- **`claudebox host-agent` — proxy the framework's host commands to the Mac** (backlog #15,
  Approach 2, **phase 1**). Lets a claudebot developing *this harness* inside a container run the
  framework's `colima`/`limactl` calls against the real Mac Colima, so the full orchestration is
  under test from a container. How it works:
  - **`host-agent.py`** — a small Mac daemon (reusing the CDP-bridge gateway pattern) that runs an
    **allowlisted** `colima`/`limactl` (binary **and** subcommand). **Security: opt-in, off by
    default; binds only the Colima gateway `192.168.64.1` (never LAN); per-session bearer token;
    subcommand-allowlisted.** It is a **trusted single-operator tool**, not a general claudebot
    capability. `claudebox host-agent up|down|status`.
  - **`cb-host-shim`** baked as `colima` + `limactl` on the container PATH — proxies each call to
    the agent. The wrapper injects the agent URL+token via a durable `-hostagent` sidecar (empty
    when the agent is down → entrypoint unsets it).
  - Proven end-to-end: a bridge-network container ran real `colima list` on the Mac (no
    `--network host` needed); the allowlist denied a non-`colima`/`limactl` command.
  - Design + phasing + full security model: [docs/design/backends.md](docs/design/backends.md).
    Not yet done: the `docker` shim (phase 3) that would make `make build`/`test.sh` fully proxy.
- `install.sh` installs `host-agent.py` next to the wrapper.

**Needs `make build`** (Dockerfile + entrypoint); rebuild auto-recreates containers.

## [2.13.0] — 2026-07-12 _(fork)_

### Added
- **`claudebox bootstrap --workspace` — first-class multi-repo projects** (backlog #13). One
  project / one VM / N repos as siblings. `--workspace` (alias `--multi-repo`) makes the
  current dir an **orchestration parent** (git init + README, but **no** `workloads/`), writes
  a multi-repo-framed BRIEF, and seeds a `.gitignore` excluding the sibling repo dirs +
  machine-local `config.yml`/`secrets.env` — so the parent never tracks the app repos as
  gitlinks (the footgun). Repeatable **`--repo <url>`** (URL or `gh owner/repo`, implies
  `--workspace`) clones each as a gitignored sibling using the host's git/`gh` auth.
  `--workspace` and `--adopt` are mutually exclusive. Docs:
  [multi-repo-projects.md](docs/design/multi-repo-projects.md).
- Internally, the bootstrap "flavor" (`adopt` | `workspace` | greenfield) now drives
  scaffolding + BRIEF framing uniformly.

Host-only (wrapper) — **no image rebuild needed**; reinstall the wrapper to pick it up.

## [2.12.0] — 2026-07-12 _(fork)_

### Added
- **`claudebox bootstrap --adopt` — adopt an EXISTING repo without the nested-repo tangle**
  (backlog #12). Plain `bootstrap` scaffolds a greenfield project (git init, README,
  `workloads/`); doing that to an existing repo is wrong, and cloning a repo *inside* the
  workspace produces the nesting mess gammaray hit. Now:
  - `bootstrap --adopt` adopts the repo already in `$PWD` — and bootstrap **auto-detects**
    this (an existing `.git` ⇒ adopt), **skipping** greenfield scaffolding so it never
    pollutes the repo, and framing the BRIEF as "this repo IS your workspace, extend it in
    place, don't re-clone it."
  - `bootstrap --adopt <url>` clones `<url>` (URL or `gh owner/repo`) **into the current
    empty dir first** (repo becomes the workspace root), then adopts. Refuses a non-empty
    dir. Uses the host's git/`gh` auth.
  - Adopting nudges you to seed `--gh-token` for private repos (git push/pull + the
    embedded-email `origin` gotcha).
  - Docs: [bootstrap.md](docs/design/bootstrap.md) (also refreshed the stale first-run
    surfacing section to the user-memory mechanism).

Host-only (wrapper) — **no image rebuild needed**; reinstall the wrapper to pick it up.

## [2.11.0] — 2026-07-12 _(fork)_

### Added — disk-management follow-ups (deferred from the disk consult)
- **Startup disk MOTD** — when the VM's `/` is ≥85% full at container boot, the entrypoint
  injects a disk warning into the claudebot's context, so a claudebot inheriting a near-full
  VM is told up front (with the prune commands + the Write-tool report escape).
- **`CLAUDEBOX_PRUNE_ON_START=1`** — opt-in: the entrypoint runs `docker builder prune -f`
  (build cache only, best-effort) on every start. Never removes tagged images; default off.
- **`CLAUDEBOX_TMPFS_TMP=<size>`** — opt-in: RAM-back the claudebot's `/tmp` (`--tmpfs`) so
  docker disk bloat can't starve the Bash tool at all. The hardest isolation; for chronically
  disk-tight projects.
- **Default `vm.disk` 60 → 100 GiB** for new projects (sparse, so near-zero Mac cost).

### Changed
- **Trimmed the baked framework guidance** ~284 → ~223 lines: the exhaustive per-language tool
  inventory is condensed to a short "what's baked" summary + "discover with `which`/`cb-help`/
  profiles", improving adherence (closer to the ~200-line guideline). Directive guidance
  (networking, disk, secrets, consult, etc.) is unchanged.

Docs: [disk-management.md](docs/design/disk-management.md), [environment-variables.md](docs/environment-variables.md).

**Needs `make build`** (entrypoint change); rebuild auto-recreates containers.

## [2.10.0] — 2026-07-12 _(fork)_

### Changed
- **Framework guidance now reaches EVERY claudebot — via `~/.claude/CLAUDE.md` (user memory),
  rewritten every start.** Previously the guidance was copied into the workspace `./CLAUDE.md`
  once, and only if the project didn't already have one — so **existing-repo projects got
  nothing**, and the copy never refreshed on harness updates (the task #10 gap). Now the
  entrypoint writes the guidance to the container's user-memory file on every boot. Claude Code
  loads `~/.claude/CLAUDE.md` additively with (and below) the project's own `./CLAUDE.md`, in
  every mode incl. `-p` / `--dangerously-skip-permissions`, so:
  - existing-repo projects (with their own `./CLAUDE.md`) now get the guidance too, untouched;
  - the guidance is always current (a reseed carries the latest);
  - the project's `./CLAUDE.md` is never written to or mixed with framework text.
- **Greenfield projects no longer get a seeded workspace `./CLAUDE.md`** — the guidance lives in
  user memory; the project creates its own `CLAUDE.md` (via `/init` or as it develops) when it
  has project-specific conventions.
- The bootstrap **mission banner** (`.claudebox/BRIEF.md`) is now surfaced *in the user-memory
  file* (conditional on the brief existing), not prepended to the workspace `CLAUDE.md`.
- Design + precedence/migration notes: [docs/design/framework-guidance.md](docs/design/framework-guidance.md).
  Follow-up: the generated file is ~280 lines — trimming toward directive essentials (letting
  `cb-help`/discovery cover the tool inventory) is worthwhile.

**Needs `make build`** (entrypoint change); the rebuild auto-recreates containers, and existing
projects pick up the guidance on their next reseed — no per-project migration needed.

## [2.9.2] — 2026-07-12 _(fork)_

### Fixed
- **Consult `watch` no longer self-triggers.** Both watchers used to wake on *any* thread
  change, so framework-Claude posting a draft/approval immediately re-triggered its own
  watcher (and a claudebot's own `open`/`say`/`resolve` re-triggered its). Each watcher now
  wakes only on transitions **it** can act on: `claudebox consult watch` (host) on a thread
  *entering* `awaiting-framework` (a new consult, or a claudebot `say`/`revise`);
  `cb-consult watch` (container) on a reply *landing* (`awaiting-claudebot`). Implemented by
  tracking only the actionable subset and firing on additions. Host side (`wrapper.sh`) is
  live on reinstall; the container side (`cb-consult`) ships on the next `make build`.

## [2.9.1] — 2026-07-12 _(fork)_

### Fixed
- **`claudebox vm gc` data-loss bug — it deleted STOPPED VMs' disks.** The orphan detection
  keyed on `limactl disk ls`'s `IN-USE-BY` column (`awk NF<5`), which is blank for any VM
  that isn't *running* — so gc treated every stopped VM's disk as junk and deleted it
  (observed: it removed the `cb-9f96a052` project VM's disk, and would have deleted the
  `cb-infra` **image store** the moment it was stopped). Fixed to cross-reference disk names
  against the known colima **profiles** (which include Stopped ones); a disk is orphaned only
  if no profile owns it. `claudebox vm usage` had the same misclassification — also fixed, and
  it now measures stopped VMs' disks by name. Host-only (wrapper) — **no image rebuild needed**;
  reinstall the wrapper (`install.sh`) to pick it up.

## [2.9.0] — 2026-07-12 _(fork)_

### Added
- **Docker disk-management standard** (produced via the consult channel — the disk issue a
  claudebot hit + escalated). A project's Colima VM has ONE overlay disk shared by docker
  (images + BuildKit build cache) AND the claudebot's `/tmp`; when docker bloat fills it, the
  Claude Code Bash tool dies with `ENOSPC` and every command fails — including the report
  tools. New:
  - **`docs/design/disk-management.md`** — the standard: one-disk-two-tenants model, prune
    discipline, budget rule, symptom→cause→fix table, and the **Write-tool escape** (when Bash
    is dead, the claudebot writes a report file directly into the mounted `framework-bugs`/
    `framework-consult` dir — no shell needed).
  - **`cb-df`** — new baked helper: `df -h /` + `docker system df` + biggest images, with a
    ≥85%-full warning. cb-* convention, cb-help-discoverable.
  - **Baked "Disk discipline" guidance** in the container `CLAUDE.md` (prune cadence, `cb-df`,
    the ENOSPC→Write-tool escape).

### Fixed
- **`claudebox vm gc` now prunes BuildKit build cache**, not just dangling images. Build cache
  is the real accumulator on image-iterating projects, and `image prune` never touches it — so
  `vm gc` was leaving the biggest reclaimable chunk on the disk.

**Needs `make build`** (entrypoint + new `cb-df` helper); rebuild auto-recreates containers.

## [2.8.1] — 2026-07-11 _(fork)_

### Changed
- **Consult alerting, claudebot half of Idea A.** Baked container guidance now tells a
  claudebot to launch `cb-consult watch` as a background task **right after it opens a
  consult** (targeted — only while it's actually waiting on a reply, not a blanket
  poller), so it's alerted the moment an approved reply lands instead of polling. If its
  session ends first, startup surfacing catches the reply next boot. Complements the
  framework-side `SessionStart` hook added just before. Baked-`CLAUDE.md` change → reaches
  **new** projects on build; existing projects pick it up when their `CLAUDE.md.template`
  is regenerated (the task-#10 propagation limitation).

**Needs `make build`** (entrypoint guidance); rebuild auto-recreates containers.

## [2.8.0] — 2026-07-11 _(fork)_

### Added
- **Consult alerting — surfacing + `watch`.** So a claudebot and framework-Claude aren't
  unaware of incoming replies/state changes:
  - **(A) Startup surfacing:** the entrypoint now injects a note into the **claudebot's**
    startup context when one of its consults is `awaiting-claudebot` (an approved reply is
    waiting) — mirroring the host wrapper already surfacing pending consults to the human.
  - **(B) `watch`:** new `claudebox consult watch` (host) and `cb-consult watch` (container)
    — **token-free** loops that block until a relevant thread changes state (new consult /
    reply landing / new turn), print what changed, and exit. Run as a background task in a
    live session; the harness re-invokes on exit → handle → relaunch. Pure files + polling
    (default 20s, `watch [secs]`); no external infra. The `framework-consult` skill uses it.
- Sequence diagram (Mermaid) + a "Staying alerted" section in
  [docs/design/framework-consult.md](docs/design/framework-consult.md).

**Needs `make build`** (entrypoint + `cb-consult` changes); the rebuild auto-recreates
existing containers on next run.

## [2.7.0] — 2026-07-08 _(fork)_

### Added
- **Framework consult — supervised claudebot ↔ framework-Claude collaboration.** A
  claudebot can escalate a *general* framework/environment problem (one that would recur
  in any claudebox project) to framework-Claude working on the harness, gated by the
  human, so the resolution becomes a **baked-in standard** instead of a per-project
  reinvention. Peer-to-peer via a shared file substrate (mounted at
  `/home/claude/framework-consult`, `CLAUDEBOX_CONSULT_DIR`); the only sub-agent is the
  Agent-tool **drafting sub-agent** framework-Claude spawns — the app-building claudebot
  is never a sub-agent. Nothing reaches the claudebot until the human approves.
  - New container helper **`cb-consult`** (`open`/`say`/`read`/`list`/`resolve`).
  - New host verb **`claudebox consult`** (`list`/`show`/`approve`/`revise`/`reject`/`post`);
    a normal `claudebox` run surfaces consults awaiting your approval or a framework draft.
  - New **`framework-consult` skill** drives the hybrid auto-draft loop (draft with a
    sub-agent → your approval → apply + reply with the commit hash).
  - Design: [docs/design/framework-consult.md](docs/design/framework-consult.md).
- **`docs/design/n-tier-networking.md` — the first standard this channel produced.** The
  N-tier addressing/binding/CORS standard (service-name vs the rotating VM IP, bind
  `0.0.0.0`, drive CORS/`allowedDevOrigins` from `$CLAUDEBOX_VM_IP`), with Next/Express/
  FastAPI snippets, a worked Next+API+postgres layout, and a symptom→cause→fix table. A
  concise version is baked into the container `CLAUDE.md`.
- **`CLAUDEBOX_HOSTNAME`** injected into the container when `network.hostname` is set —
  the rotation-proof stable alias for the VM IP (rides the `-vmip` sidecar).

**Needs `make build`** (entrypoint + new `cb-consult` helper); the rebuild auto-recreates
existing containers on next run.

## [2.6.0] — 2026-07-08 _(fork)_

### Added
- **`CLAUDEBOX_VM_IP` — the claudebot now knows its VM's reachable IP.** The container
  sits on the VM's docker bridge (`172.x`) and cannot self-discover the reachable
  `192.168.64.x` (col0) address — the *only* address the human's Mac (and its Chrome,
  over CDP) can reach a published workload at. The wrapper now injects the current IP as
  `CLAUDEBOX_VM_IP`, both via `docker run -e` and via a durable `-vmip` sidecar refreshed
  every run — so it survives `docker start` **and self-heals when the IP rotates across
  VM restarts** (a real failure here: `.13` → `.16` left a stale IP baked in
  `next.config.ts`). New helpers: `cb-browser ip` (in-container) and `claudebox ip`
  (host, bare scriptable IP; `claudebox net` keeps the full dashboard).

### Fixed / Changed
- **`cb-browser cdp` auto-rewrites `localhost`/`127.0.0.1`/`0.0.0.0` targets to the VM
  IP** (with a printed note) instead of silently failing — the Mac's Chrome can't reach
  a VM workload via localhost, and rediscovering that burned real cycles.
- **Baked container guidance rewritten** for the VM-IP reachability model: the VM IP is
  THE address for Mac/Chrome to reach workloads; it **rotates** so never hardcode it
  (read `$CLAUDEBOX_VM_IP`/`cb-browser ip` fresh — not in `allowedDevOrigins`,
  `server.allowedHosts`, CORS, `.env`, or test URLs); `localhost` demoted to a fragile,
  collision-prone fallback; and prefer `cb-browser cdp`/`script` over a hand-rolled
  `connectOverCDP` (which can trip on `Browser.setDownloadBehavior` vs a stock Chrome).
- Docs: [docs/design/browser-testing.md](docs/design/browser-testing.md) gains a CDP
  reachability + rotating-VM-IP tips section.

**Needs `make build`** (entrypoint change); the rebuild auto-recreates existing
containers on next run.

## [2.5.2] — 2026-07-07 _(fork)_

### Fixed
- **`browser-bridge up` now reaches an already-running claudebot.** The CDP bridge URL
  (`CLAUDEBOX_HOST_CDP_URL`) was injected **only** via `docker run -e`, so it never
  landed in a container that already existed — a restart is `docker start`, which can't
  add env, and there was no durable fallback (unlike auth/secrets). Bringing a bridge up
  had no effect until the container was recreated. Now the wrapper also writes the URL
  to a durable `.<container>-cdp` sidecar (empty when the bridge is down) that the
  entrypoint re-reads on every start — so `browser-bridge up`/`down` take effect on the
  next plain `claudebox` run, no recreation needed. The sidecar is a derived mirror of
  the marker (rewritten each invocation, self-heals to empty, removed by `destroy
  --purge`) — see [docs/design/browser-testing.md](docs/design/browser-testing.md).
  **Needs `make build`** (entrypoint change); the rebuild auto-recreates existing
  containers on next run.

## [2.5.1] — 2026-07-07 _(fork)_

### Fixed
- **Guard against running claudebot from inside `.claudebox`.** `cd`-ing into the
  metadata dir and running `claudebox` used to silently create a *stray* container that
  mounts `.claudebox` as the workspace (the VM/identity were still correct — the root is
  the git toplevel). Now the wrapper detects it, warns with the right `cd <project-root>`
  hint, and prompts (interactive) or aborts (non-interactive; override with
  `CLAUDEBOX_ALLOW_SUBDIR=1`). Host-only — no `make build` needed.

## [2.5.0] — 2026-07-07 _(fork)_

### Added
- **`CLAUDEBOX_NO_API_KEY=1`** — never send an `ANTHROPIC_API_KEY` into the container,
  even if one is exported on the Mac, so a claudebot uses your **Claude subscription**
  (browser OAuth / `claudebox setup-token`) instead of pay-per-token API billing. The
  wrapper drops the key; the entrypoint now **unsets** an empty auth value (rather than
  skipping it), so a key baked into an already-created container's env at `docker run`
  time is cleared too — the switch works on existing containers, not just fresh ones.

## [2.4.0] — 2026-07-07 _(fork)_

### Added
- **Profile system** — opt-in tool bundles per project. Declare `profiles: [typescript,
  python, go]` in `.claudebox/config.yml`; the entrypoint installs each matching baked
  installer (`/usr/local/lib/claudebox/profiles/<name>.sh`) once on first enable
  (marker-guarded, retries on offline failure), as the `claude` user. Ships
  `typescript` / `python` / `go` profiles (enable the respective `*-lsp` plugin; servers
  are baked). `claudebox profiles` lists enabled + available; `init.d/*.sh` stays the
  escape hatch. Policy — bake small/common LSP binaries, install heavy/niche per profile;
  the profile hides which. See [docs/design/profiles.md](docs/design/profiles.md).

## [2.3.0] — 2026-07-07 _(fork)_

### Added / Fixed
- **Bake the common LSP servers** into the full image so their Claude Code `*-lsp`
  plugins work — the plugins ship **no binary** (just a README descriptor), so they
  were silently non-functional without the server on PATH. Added
  **`typescript-language-server`** (TS/JS) and **`pyright`** (Python), joining the
  already-baked **`gopls`** (Go). Policy: small, common language servers are baked
  universally; heavy/niche ones stay per-profile (see task #14). Fixes the
  `examples/todo-app` TS-LSP hook, which installed the plugin but not its server.

## [2.2.0] — 2026-07-06 _(fork)_

Container-side convenience: a discoverable helper convention + an inside-the-container
`/claudebox` skill. **Requires `make build`** (image changes) to reach a claudebot.

### Added
- **`cb-*` convenience-command convention** — helpers the claudebot runs *inside* the
  container are named `cb-<name>`, carry a `# summary:` header, and are discovered by
  the new **`cb-help`** (baked). Baked helpers live in `/usr/local/bin`; per-project
  ones in `~/.claude/bin` (on PATH). `cb-browser` / `cb-report-bug` gained summaries.
  See [docs/design/convenience-scripts.md](docs/design/convenience-scripts.md).
- **Container-side `/claudebox` skill** — seeded into the claudebot by the entrypoint
  (rewritten each start so it stays current). A harness self-report from *inside*:
  version (`$CLAUDEBOX_VERSION`), `cb-help`, `~/CHANGELOG.md`, and the workspace/`cb-net`
  environment. (Distinct from the host `/claudebox` skill, which runs `claudebox info`.)
- The baked `CLAUDE.md` now tells the claudebot about `cb-help` and the `cb-*` convention.

## [2.1.0] — 2026-07-06 _(fork)_

Operability release — the day-to-day human/agent tooling on top of 2.0.0's core.

### Added
- **`claudebox info`** (alias `status`) — human at-a-glance dashboard: versions
  (wrapper / cb-infra / project image), the paths that matter (config.yml,
  secrets.env, per-project data dir), VM + container status, and network (VM IP,
  hostname, cb-net).
- **`/claudebox` Claude Code skill** — runs `claudebox info` from any project;
  shipped in the repo (`skills/`) and installed to `~/.claude/skills/` by
  `install.sh` (skip with `CLAUDEBOX_SKIP_SKILL=1`).
- **`CLAUDEBOX_CAFFEINATE=1`** — opt-in; keeps the Mac awake for the duration of a
  foreground claudebox session (interactive / programmatic) via `caffeinate -w $$`,
  so a long claudebot run doesn't stall when the machine sleeps and Colima suspends.
- **`claudebox destroy --purge`** — also delete the project's host data dir (session
  history, `--continue`, auth/secrets sidecars, settings) for a clean slate.
- **`claudebox vm usage` / `vm gc`** — per-VM disk footprint, and reclaim
  (orphaned-disk prune + **dangling (old) image prune** + `fstrim` of running cb-*
  VMs). `make build` also prunes the image it just superseded, so repeated builds
  don't pile up `<none>` images in cb-infra. `vm destroy` reaps the lima datadisk
  `colima delete` leaks.
- **`claudebox checkversion` severity** — classifies drift as MAJOR (must rebuild) /
  MINOR (should) / PATCH (optional).
- **Auto image propagation** — a rebuilt image auto-reseeds into a running project VM
  and the container is recreated on it (no manual `rmi`); session state preserved.
- **git identity fallback** — uses the host's `git config` when `CLAUDEBOX_GIT_*`
  are unset, so a fresh claudebot can always commit.
- **`network.hostname` discoverability** — `ip`/`net` and the generated config now
  suggest a friendly name, and **`claudebox net <hostname>`** sets it directly (no
  hand-editing YAML) then prints the `/etc/hosts` line.
- **`claudebox --help`** (`-h`) — a top-level usage summary of all commands + key env.

## [2.0.0] — 2026-07-06 _(fork)_

First versioned release of this fork. It opens the fork's own `2.x` line — chosen to
sit above upstream's `1.x` (highest pre-fork tag `v1.11.0`) so versions/tags never
collide and order coherently across the shared lineage. Changes from the upstream
fork point through `2.0.0` are **not itemized here** (they predate this policy — see
the git history / the README); from `2.0.0` on, every version bump gets an entry.

### Added
- **Semantic versioning** for the host↔image contract: a `VERSION` file +
  `CLAUDEBOX_VERSION` in `wrapper.sh` (kept in sync by a test) + an image stamp
  (`LABEL org.claudebox.version`). `claudebox version` prints the wrapper's semver;
  `claudebox checkversion` compares it against the claudebot image and warns on
  drift. See [docs/versioning.md](docs/versioning.md).

## [v1.11.0] — 2026-04-30

### Added
- **Telegram per-chat overrides** stored in `~/.claude/telegram_overrides.json`, persisting across bot restarts and trumping the YAML config:
  - `/model` — inline keyboard or `/model <name>`; choices: `haiku`, `sonnet`, `opus`, `opusplan`, `reset`.
  - `/effort` — same UX; choices: `low`, `medium`, `high`, `xhigh`, `max`, `reset` (verified against the official Claude CLI docs).
  - `/system_prompt [text|reset]` — show/set/clear system-prompt override per chat.
  - `/append_system_prompt [text|reset]` — same for the appended system prompt.
- `opusplan` model alias surfaced everywhere: telegram bot, OpenAI `/openai/v1/models`, MCP tool docstring, docs.
- `tests/test_cron_telegram.sh` — unit + integration tests for the cron/telegram bridge: round-trip message tracking, prune to 200 entries, no-`--continue` on cron replies, `CRON_SYSTEM_HINT` content, combined-entrypoint smoke test.
- `run-e2e-cron-telegram.sh` — end-to-end script (sources `tests/.env` for credentials) for the cron+telegram reply-context flow.

### Changed
- `get_chat_config()` merges in-memory + on-disk overrides on top of YAML defaults.
- `_apply_choice` / `_send_choice_keyboard` / `_BUTTON_HANDLERS` shared plumbing for keyboard-driven overrides.

### Security
- `run-e2e-cron-telegram.sh` now sources `tests/.env` instead of carrying hardcoded OAuth/bot tokens. (A previously-committed token in `v1.10.0`'s `run-test.sh` was auto-revoked by Anthropic's secret scanning; new token issued and stored only in gitignored `tests/.env`.)

## [v1.10.0] — 2026-04-29

### Added
- **Combined cron + telegram mode**: when both `CLAUDEBOX_MODE_CRON=1` and `CLAUDEBOX_MODE_TELEGRAM=1` are set, the entrypoint runs the cron scheduler in the background and the telegram bot in the foreground (trap kills cron when the bot exits).
- Cron yaml supports `telegram_chat_id` (root-level default + per-job override) — finished jobs post their result to Telegram.
- **Cron-reply context injection**: when a user replies to a cron notification in Telegram, the bot looks up the original job (name, fired_at, instruction, result) in `~/.claude/cron/telegram_messages.json` and prepends it to the prompt. Cron replies always run in a fresh session (no `--continue`); regular messages keep `--continue`.
- Chat-wide cron awareness: the most recent 10 cron runs are injected into every prompt's `--append-system-prompt` so Claude can answer questions about them without an explicit reply.
- `telegram_utils.py` shared module (`BOT_TOKEN`, `make_bot()`, `send_long()`); `send_long()` now returns the list of sent `Message` objects so the caller can capture `message_id`.
- `wrapper.sh` gained a named `_cron` container with start/stop/restart parity to `_prog`, plus an auth file.

## [v1.9.0] — 2026-04-29

### Added
- Cron jobs support `system_prompt` / `append_system_prompt` (root-level + per-job override).
- Template variables expanded at fire time: `{system_datetime}`, `{job_name}`.

## [v1.8.0] — 2026-04-29

### Added
- `claudebox mcp ...` wrapper passthrough (`list`, `add`, `remove`, …) so MCP server management works the same as bare `claude mcp`.
- Documentation covering MCP server scopes (project `.mcp.json`, user, local) with CLI examples.

## [v1.7.0] — 2026-04-29

### Added
- **Cron mode** (`CLAUDEBOX_MODE_CRON=1`): yaml-scheduled Claude jobs with sub-minute resolution, per-job history under `~/.claude/cron/history/<workspace-slug>/<ts>-<job>/`, overlap protection, and foreground logging.

### Changed
- Environment variable namespace renamed `CLAUDE_*` → `CLAUDEBOX_*`. Legacy `CLAUDE_*` names are still accepted as fallbacks for backwards compatibility.

## [v1.6.0] — 2026-04-29

### Added
- Proper standalone installer (`install.sh`) that drops in a working setup with one command.

## [v1.5.0] — 2026-04-29

### Fixed
- Misc release-blocking bugs.

## [v1.4.1] — 2026-04-29

### Fixed
- Installer script regressions; bumped pinned Claude CLI version.

## [v1.4.0] — 2026-04-16

### Changed
- Base image upgraded to **Ubuntu 24.04** (CVE reduction).
- Adopted DEB822 apt sources; dropped `apt-transport-https` (no longer needed).
- `pip3 --break-system-packages --ignore-installed` to work around PEP 668 + PyJWT conflict.
- `userdel ubuntu` before `useradd claude` to free UID 1000.
- `exa` → `eza` (exa is unmaintained); `mysql-client` → `default-mysql-client`.
- Dropped `python3-venv`.

## [v1.3.0] — 2026-04-16

### Added
- **Async run mode** in API: `POST /run` with `async: true`, `GET /run/result` for polling. Run IDs included on every response. Read-once result cache with 6-hour TTL. Cancel by `runId`. `/status` now lists active runs.

### Changed
- All API responses include `workspace`.
- Switched build apt mirror to Cloudflare for faster Docker builds.
- README updated with full response schemas.

### Fixed
- `asyncio.Lock` around run state to eliminate races.

## [v1.2.0] — 2026-04-11

### Security
- Telegram **path traversal** fix on file operations.
- Auth file mode hardened to `chmod 600`.
- Entrypoint **command-injection** fix via `printf %q` quoting.
- `jq` failure protection.
- Port number validation.
- Install script fail-safe.

### Changed
- `/status` response normalized to camelCase.
- Test isolation via `mktemp`.

## [v1.1.0] — 2026-04-11

### Added
- `make test` target.
- `.dockerignore` (faster, smaller build context).
- Test for entrypoint always-skills wiring.

### Changed
- Tests refactored to a table-driven layout with workspace-relative test dirs.
- README revamp.

## [v1.0.0] — 2026-04-11

### BREAKING
Project renamed from `docker-claude-code` → **`claudebox`**:
- Docker image: `psyb0t/docker-claude-code` → `psyb0t/claudebox`.
- Binary: `claude-code` → `claudebox`.
- SSH dir: `~/.ssh/claude-code` → `~/.ssh/claudebox`.
- GitHub repo: `psyb0t/docker-claudebox`.

## [v0.39.0] — 2026-04-11

### Added
- **Always-skills**: scan `~/.claude/.always-skills` for `SKILL.md` files and inject them (with file-path prefix) into every Claude invocation across interactive, programmatic, API, and OpenAI modes.

## [v0.38.0] — 2026-04-10

### Added
- Structured JSON logging (`ts`, `level`, `logger`, `func`, `line`, `file`, `msg`) across auth, `/run`, OpenAI, MCP, and image handling. `DEBUG=1` enables debug level.

## [v0.37.0] — 2026-04-10

### Added
- **OpenAI multimodal**: base64 + URL images saved to the workspace and forwarded to Claude.
- Real usage-token reporting on OpenAI responses.
- Multi-turn via conversation JSON file.
- `X-Claude-Append-System-Prompt` request header.

### Changed
- Extra/unknown OpenAI fields silently ignored.

## [v0.36.0] — 2026-04-10

### Changed
- All 24 tests in `ALL_TESTS`; every assertion now checks the response body, not just status codes.

## [v0.35.0] — 2026-04-10

### Fixed
- `streamable_http_app` for MCP.
- MCP lifespan registered via FastAPI.
- `stream-json` assistant-event parsing.
- `--continue` flag logic.
- MCP tests with proper session init.

## [v0.34.0] — 2026-04-10

### Changed
- OpenAI `/v1/models` returns bare aliases (`haiku`, `sonnet`, `opus`).
- Provider prefix (`openai/`, `claudebox/`) stripped from inbound model names.
- Tests use `$TEST_MODEL` instead of hardcoded values.

## [v0.33.0] — 2026-04-10

### Added
- **OpenAI-compatible adapter** at `/openai/v1` (streaming, custom headers, `reasoning_effort`).
- **MCP server** at `/mcp` exposing `claude_run`, file operations, and auth tools.
- Shared `_run_claude_text` helper.

## [v0.32.0] — 2026-04-07

### Changed
- camelCase response normalization across the board: `jsonpipe.py` normalizes `json` / `stream-json` / `json-verbose`, wrapper pipes all formats. Tests assert recursively against snake_case.

## [v0.31.0] — 2026-04-07

### Fixed
- `asyncio.StreamReader` 64KB-line crash in API.
- Truncate `json-verbose` tool results > 2K with sha256 hash.

## [v0.30.0 – v0.29.0] — 2026-04-07

### Added
- `outputFormat: json-verbose` — assembles `stream-json` into a single JSON document with a `turns` array showing all tool calls.

## [v0.28.0] — 2026-04-03

### Added
- `clear-session` wrapper command.

### Fixed
- `--no-continue` without prompt.

### Changed
- README env-var section restructured.

## [v0.27.0] — 2026-04-03

### Changed
- camelCase normalization rolled out further.

## [v0.26.0] — 2026-04-03

### Removed
- Claude Code Router (CCR) integration.

### Changed
- Bumped Claude CLI to 2.1.90.

## [v0.25.0] — 2026-04-03

### Changed
- API moved to camelCase.
- Auto-updates now opt-in.
- Bumped CLI to 2.1.89.

## [v0.24.0] — 2026-04-01

### Added
- `claudebox stop` wrapper command.

## [v0.23.1 – v0.23.0] — 2026-03-31

### Added
- Wrapper passthrough for utility commands: `--version`, `doctor`, `auth`.

### Changed
- Go bumped 1.25.5 → 1.26.1.

## [v0.22.0] — 2026-03-31

### Added
- System hint appended to all modes — informs Claude about container info, image variant, sudo access, bin path, and host-path mapping.

## [v0.21.x] — 2026-03-30/31

### Added
- `CLAUDE.md` template seeded into all workspaces (telegram, API, interactive).
- Makefile build targets.

### Fixed
- Telegram cancel-retry bug; better logging.
- API kills the Claude process on client disconnect (opt out via `fire_and_forget`).

## [v0.20.x] — 2026-03-30

### Added
- **Telegram bot mode** (`CLAUDE_MODE_TELEGRAM=1`): per-chat workspaces, file/photo/video/voice handling, command menu, HTML formatting with plain-text fallback.

### Fixed
- Empty-file crash; httpx polling-spam silenced; proper logging.
- Filters, media handlers, command menu wiring.

## [v0.19.0] — 2026-03-30

### Added
- `--no-continue` and `--resume` wrapper flags.

### Changed
- Bumped Claude CLI to 2.1.87.

## [v0.18.x] — 2026-03-28

### Changed
- Hardcoded `/workspaces` as the API root; removed `CLAUDE_MODE_API_ROOT_WORKSPACE` env var.

### Fixed
- Workspace permissions.

## [v0.17.0] — 2026-03-28

### Added
- `--effort` (reasoning effort) flag in wrapper and API.

### Removed
- `claude-code-router` support.

## [v0.16.x] — 2026-03-28

### Added
- API expansion: `/files` with path params (`GET`/`PUT`/`DELETE`), `/health`, `/status`, `/run/cancel`.
- `--system-prompt`, `--append-system-prompt`, `--json-schema` flags in wrapper + API.
- Graceful API shutdown.
- `--continue` automatic fallback when no prior session.

### Changed
- API output is now JSON-only.

## [v0.15.0] — 2026-03-28

### Added
- **API mode** (`CLAUDE_MODE_API=1`) — FastAPI server.
- Multi-stage Dockerfile: `minimal` and `full` variants; `CLAUDE_MINIMAL` runtime flag.
- `CLAUDE_MOUNT_*` extra volume mounts.
- Per-workspace `409` locking.

### Changed
- `wrapper.sh` extracted from `install.sh` for clarity.

## [v0.14.x] — 2026-03-09/19

### Added
- `CLAUDE_MOUNT_*` extra volume mounts (same-path default, or explicit `src:dest`).
- Container env notes + overwrite warning baked into `CLAUDE.md`.

### Fixed
- Permissions / `chown` cleanup.

## [v0.13.x] — 2026-03-01/03

### Added
- `~/.claude/bin` in `PATH` for custom user scripts.
- `~/.claude/init.d/` hooks fired on first container creation.
- `CLAUDE_ENV_*` passthrough.
- `CLAUDE_INSTALL_DIR`, `CLAUDE_SSH_DIR`, `DEBUG` env-var docs.

### Removed
- Ephemeral mode (programmatic uses its own container — ephemeral was redundant).

## [v0.12.0] — 2026-02-27

### Added
- `--model` flag for programmatic / ephemeral runs.
- All available models documented.

## [v0.11.x – v0.10.x] — 2026-02-27

### Added
- **Programmatic** and **ephemeral** modes.
- `--no-update` flag (file-signal based).
- Argument whitelist + container lock.
- `--continue` automatic fallback.

### Changed
- Background auto-updates disabled by default.
- Restart instead of attach to existing containers.
- Trust pre-accept on first run.
- Bumped Claude CLI to 2.1.62.

### Fixed
- Silenced output for programmatic / ephemeral runs.

## [v0.9.x] — 2026-01-08 → 2026-02-03

### Added
- Native Claude installer (no more npm).

### Fixed
- Runtime permission fixes.
- Misc bug fixes; README updates.

## [v0.8.0] — 2025-12-10

### Added
- pyenv with Python 3.12.
- Auto-generated `CLAUDE.md` so Claude knows what tools are available in the container.

## [v0.7.x – v0.6.0] — 2025-11-23 → 2025-12-08

### Added
- Pinned Claude CLI version for reproducible builds.

## [v0.5.x] — 2025-10-10/13

### Fixed
- DNS resolution issue.

### Changed
- Image rebuild.

## [v0.4.0 – v0.1.0] — 2025-06-14 → 2025-08-25

Initial development: base image, more bundled tooling, project bootstrap.

[v1.11.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.11.0
[v1.10.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.10.0
[v1.9.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.9.0
[v1.8.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.8.0
[v1.7.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.7.0
[v1.6.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.6.0
[v1.5.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.5.0
[v1.4.1]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.4.1
[v1.4.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.4.0
[v1.3.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.3.0
[v1.2.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.2.0
[v1.1.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.1.0
[v1.0.0]: https://github.com/psyb0t/docker-claudebox/releases/tag/v1.0.0

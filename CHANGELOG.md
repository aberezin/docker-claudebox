# Changelog

All notable changes to **claudebox** (formerly `docker-claude-code`).

Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions before `v1.0.0` are pre-release; the rename to `claudebox` at `v1.0.0` is the only breaking change in the project's history.

> **Fork note:** this fork maintains its **own** semver line, starting at `2.0.0`
> (2026-07-06) — deliberately **above** upstream's highest pre-fork tag (`v1.11.0`)
> so the fork's versions/tags never collide with the inherited upstream history and
> sort cleanly above it (useful if upstream ever pulls from us, or we pull from
> them). The `v1.x` history further below is upstream claudebox's (by
> [psyb0t](https://github.com/psyb0t/docker-claudebox)) up to the fork point.
> Detailed fork changes *between* the fork point and `2.0.0` were **not** recorded
> here (see the git history and the README's
> [What's different in this fork](README.md#whats-different-in-this-fork)); the
> changelog is authoritative from `2.0.0` onward. Release process:
> [docs/versioning.md](docs/versioning.md).

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

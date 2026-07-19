# Design: Docker disk management under the per-project VM

**Status:** Accepted standard — produced by a [framework consult](framework-consult.md).
**Applies to:** every dridock project (any claudebot that builds/pulls docker images).
See [per-project-vm.md](per-project-vm.md) for the VM model this builds on.

## Summary

Each dridock project runs in **its own Colima VM with a single overlay disk**. That
one disk holds *both* the project's docker data (images, containers, and BuildKit build
cache) *and* the claudebot container's `/tmp` — where the Claude Code **Bash tool**
writes `/tmp/claude-501/<id>` for every command. Docker bloat and the Bash tool
therefore **compete for the same bytes**. When repeated `docker compose build` /
large image pulls saturate the disk, the Bash tool can no longer `mkdir` its tempdir
and **every Bash call fails** with `ENOSPC: no space left on device` — including
`cb-report-bug` and `cb-df`, which are themselves Bash. This document is the standard
for keeping that from happening and recovering when it does.

## The mental model (one disk, two tenants)

```
project Colima VM  (cb-<id>, e.g. disk: 60GiB — sparse, grows on demand)
└─ single overlay / guest filesystem  "/"
   ├─ /var/lib/docker   ← images + containers + BuildKit build cache  (grows with every build/pull)
   └─ /tmp              ← the Claude Code Bash tool's per-command scratch (/tmp/claude-501/<id>)
```

Two consequences fall straight out of this:

1. **Docker can starve the Bash tool.** There is no reservation between the two. A
   runaway build cache fills `/`, and the *next thing to fail is your shell*, not docker.
2. **The failure is near-total and near-silent.** Once `mkdir /tmp/claude-501/<id>`
   fails, you cannot run *any* command to diagnose or self-report — the tools that
   would help (`df`, `cb-df`, `cb-report-bug`) all need Bash. The out-of-band escape
   below (the **Write tool**) is the only path that survives.

## Prune discipline (what to run, when)

All commands run **inside the VM** — the claudebot's `docker` CLI targets its own VM's
daemon directly (the socket is mounted). Prune *as you iterate*, not once at the end.

| When | Command | Reclaims |
|---|---|---|
| After each image build iteration | `docker builder prune -f` | BuildKit **build cache** (the usual hidden hog — accumulates blobs every rebuild) |
| Keep only recent cache | `docker builder prune -f --keep-storage=2GB` | build cache older than the kept budget |
| After replacing/rebuilding an image | `docker image prune -f` | **dangling** (untagged) image layers |
| Reclaim all unused images | `docker image prune -af` | every image not used by a container |
| Age-scoped cleanup | `docker image prune -af --filter "until=24h"` | unused images older than 24h |
| Big hammer (stopped containers + nets + dangling images + **all** build cache) | `docker system prune -f` | broad; add `-a` to also drop unused images, `--volumes` to drop unused volumes |

Rules of thumb:

- **Build cache is the thing that grows without bound**, not tagged images. `docker
  builder prune -f` after each `docker compose build` iteration is the single most
  effective habit. `docker image prune` alone (which is all the host `dridock vm gc`
  does per VM) does **not** touch build cache.
- **Detached workloads pin their images.** `docker image prune -af` won't remove an
  image a running container uses — stop throwaway test containers first.
- Prefer `builder prune` / `image prune` (surgical) over `system prune -a` (blunt) in a
  live session, so you don't nuke a base image you're about to reuse.

## In-VM disk visibility

You cannot manage what you cannot see, and the host tools (`dridock vm usage`) are on
the Mac — not reachable from inside the container.

- `df -h /` — the one number that matters: free space on the shared overlay. Watch it
  before and after builds. If "Use%" is climbing toward the 90s, prune *now*.
- `docker system df` — the breakdown (Images / Containers / Local Volumes / **Build
  Cache**) so you know *which* tenant is eating the disk. `docker system df -v` lists
  every object, largest first.
- **`cb-df`** — one baked command that prints `df -h /`, then `docker system df`, then
  the biggest images, as an at-a-glance snapshot. Follows the [`cb-*`
  convention](convenience-scripts.md) (`# summary:` header, discovered by `cb-help`).

Host-side, the human has the complementary view and reclaim path:

| Command (on the Mac) | What it does |
|---|---|
| `dridock vm usage` | per-VM **actual** Mac footprint (VM disks are sparse) + orphaned disks |
| `dridock vm gc` | reclaim: delete orphaned lima disks + prune images **and build cache** + `fstrim` running cb-* VMs so freed guest blocks return to macOS |

Note the sparse-disk subtlety (see [per-project-vm.md](per-project-vm.md)): pruning
*inside* the guest frees guest space immediately, but the **host** raw disk file keeps
its high-water mark until a TRIM — which `dridock vm gc` issues via `fstrim`. So "I
pruned but the Mac still shows the VM as huge" is expected until `gc`.

## VM disk sizing

The per-project disk is set in `.dridock/config.yml`:

```yaml
vm:
  cpu: 4
  memory: 8GiB
  disk: 60GiB      # default; raise for image-heavy projects
```

- Default is **60GiB**. The disk is **sparse** — a larger cap costs no Mac disk until
  actually used, so a project that iterates on Next/Playwright images can safely bump
  `disk: 100GiB` with little downside.
- **Growing the disk needs a VM recreate** — Colima sizes the disk at VM creation.
  Change `vm.disk`, then `dridock down` and start again (a bigger `disk:` on an
  existing VM is not applied live).
- The `cb-infra` image-store VM is separate (`DRIDOCK_INFRA_DISK`, install-time only,
  default 40) and is not where your build churn lands — that's your project VM.

### Budget rule of thumb

| Item | Rough cost |
|---|---|
| Playwright base image (`mcr.microsoft.com/playwright:*-jammy`) | ~1–2 GB |
| A built Next.js app image | ~1–2 GB |
| **Each** `docker compose build` iteration (uncached layers) | ~0.3–1 GB of retained build cache until pruned |
| The claudebot's own image + `/tmp` churn | low, but it's the tenant that *dies first* when `/` fills |

Three or four frontend rebuilds plus a Playwright pull can burn **5–8 GB** of cache on
top of the images — enough to crowd `/tmp` on a disk already carrying other workloads.
Prune per iteration and this never approaches the 60 GiB cap.

## Symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| `ENOSPC: no space left on device, mkdir '/tmp/claude-501'` on **every** Bash call | Shared overlay full; Bash tool can't create its scratch dir | You can't shell out. Use the **Write-tool escape** (below) to report, then have the human run `docker system prune -af` / `dridock vm gc` on the Mac. Bash recovers once `/` has room. |
| `df -h /` "Use%" in the 90s mid-session | Build cache / unused images accumulating | `docker builder prune -f`, then `docker image prune -af` |
| Pruned inside the VM but `dridock vm usage` still shows it huge | Sparse host disk keeps its high-water mark until TRIM | `dridock vm gc` (fstrims running cb-* VMs) |
| Disk fills fast on an image-heavy project even with pruning | 60 GiB too small for the workload | Raise `vm.disk` in `.dridock/config.yml`, `dridock down`, restart |
| `docker image prune` frees little though the disk is full | Build **cache** (not images) is the hog; `image prune` doesn't touch it | `docker builder prune -f` (or `docker system prune -f`) |

## Graceful ENOSPC & the out-of-band report path

When the disk is already full, **Bash is dead** — so a "report path that doesn't depend
on Bash" must **not be a shell command**. `cb-report-bug` and `cb-consult` are Bash
scripts and will themselves fail with ENOSPC.

**The escape: your Write tool still works.** It writes a file directly, without spawning
a shell or a tempdir. Both the framework-bug drop and the consult store are **host
bind-mounts** present in every container:

- Framework bugs → `/home/claude/framework-bugs/` (env `DRIDOCK_FRAMEWORK_BUGS_DIR`)
- Consults → `/home/claude/framework-consult/` (env `DRIDOCK_CONSULT_DIR`)

So when Bash is failing on ENOSPC, **Write a Markdown file straight into the drop dir** —
mirror the layout `cb-report-bug` would produce:

```
/home/claude/framework-bugs/<project-id>-<YYYY-MM-DDTHH-MM-SS>-<slug>.md
```

with a body like:

```markdown
# <short title>

- **layer:** image
- **filed:** <timestamp>

## What I was doing
...
## Expected vs actual
The Bash tool started failing every call with ENOSPC on /tmp/claude-501;
the VM overlay is full. Filed via the Write tool because cb-report-bug (Bash) also fails.
```

This reaches the maintainer exactly as `cb-report-bug` output does (same dir, same
collection path `dridock framework-bugs`). Then tell the human to reclaim disk from the
Mac (`docker system prune -af` / `dridock vm gc`); Bash recovers once `/` has room.

The **bare, guidance-free ENOSPC** message the Bash tool surfaces (a raw Node error with
no hint about the VM disk) is a **Claude Code upstream** concern, not something dridock
can fix in the tool itself. dridock mitigates it with this doc, the baked "Disk
discipline" guidance, `cb-df`, prune-aware `vm gc`, and an optional startup disk MOTD —
but the in-tool message improvement belongs upstream.

## What dridock bakes in

### Cleanup mechanisms at a glance

Cleanup is spread across three layers because the disk problem shows up in three places
(build daemon that produces images, run daemon that stores them, container's `/tmp`):

| Mechanism | Runs where | What it prunes | Trigger |
|---|---|---|---|
| Makefile `build` / `build-minimal` (2.20.1) | **cb-infra** daemon | dangling images + **BuildKit cache** (non-`-a`, unreferenced only) | every `make build` (or `dridock harness sync`) |
| `DRIDOCK_PRUNE_ON_START=1` (2.11.0, 2.15.3) | **project VMs** | BuildKit cache + dangling images | every container start (opt-in) |
| `dridock vm gc` (2.9.0) | all running `cb-*` VMs (incl. cb-infra) | orphaned lima disks + dangling images + **BuildKit cache** + `fstrim` | manual, on the Mac |

None of these is redundant — the Makefile keeps cb-infra tidy where builds happen,
`PRUNE_ON_START` keeps a project VM tidy where runs happen, and `vm gc` is the manual
reclaim (also fstrims so freed guest blocks return to macOS — the only path that shrinks
the sparse host raw disks). The nuclear escape hatch is always
`docker --context colima-cb-<id> builder prune -af` (build cache) +
`docker --context colima-cb-<id> system prune -af` (everything else) — reserved for when
BuildKit's snapshotter has corrupted itself (rare but real). For the specific case of
cb-infra BuildKit corruption during a rebuild, **`dridock harness sync --repair`**
(2.21.0) automates it: runs `make build`, greps stderr on failure for the corruption
pattern, and if matched auto-prunes the cache and retries once.

### Individual mechanisms

- **Baked container guidance** — a "Disk discipline" section in the framework guidance
  (`~/.claude/CLAUDE.md`): watch `df -h /`, prune cadence, and the Write-tool report
  escape — so every claudebot self-diagnoses.
- **`cb-df`** — the in-VM disk snapshot helper (see [In-VM disk visibility](#in-vm-disk-visibility)),
  following the [`cb-*` convention](convenience-scripts.md).
- **Prune-aware `dridock vm gc`** — the host reclaim command also prunes build cache
  per VM (not only dangling images), because build cache is the real accumulator.
- **Post-build cache prune on cb-infra** — the Makefile's `build` / `build-minimal`
  targets run `docker builder prune -f` (dangling BuildKit cache, non-`-a` so recently-
  used layers survive) after each build. Without this, cb-infra's BuildKit cache grew
  unbounded across rebuilds — a real 41 GB accumulation over four days of harness
  iteration triggered the addition in 2.20.1. Since `dridock harness sync` invokes
  `make build` under the hood, both paths get the same treatment.
- **Startup disk MOTD** — when `/` is ≥85% full at container boot, the entrypoint injects a
  disk warning into the claudebot's context (via `--append-system-prompt`), so a claudebot
  inheriting a near-full VM is told up front.
- **Larger default `vm.disk`** — new projects default to **100 GiB** (was 60). The disk is
  sparse, so the larger cap costs no Mac disk until used.

### Opt-in hardening

- **`DRIDOCK_PRUNE_ON_START=1`** — the entrypoint runs `docker builder prune -f` (build
  cache) AND `docker image prune -f` (dangling, untagged, unreferenced images) on every
  start, so both classes of accumulation are cleared on image-iterating projects. Best-effort
  and safe: `image prune -f` only touches untagged images with no container reference — never
  a tagged image, never a running container's image. Off by default.
- **`DRIDOCK_TMPFS_TMP=<size>`** (e.g. `2g`, or `1`/`on` for 2g) — RAM-backs the
  claudebot's `/tmp` so docker disk bloat **cannot** starve the Bash tool at all (its
  `/tmp/claude-501` scratch is then on RAM, not the shared overlay). This is the hardest
  isolation; use it for chronically disk-tight projects. `--tmpfs` applies to a fresh
  `docker run`, so it takes effect when the container is (re)created. Sized in RAM, so keep
  it modest relative to the VM's memory.

If any of this bites you or is missing, that's framework feedback: open a
[consult](framework-consult.md) (best-practice question) or `cb-report-bug` (defect) —
or, if Bash is down, Write the report file directly as above.

## See also

- [per-project-vm.md](per-project-vm.md) — the per-project Colima VM model, sparse disks, `vm usage` / `vm gc`, and the config schema (`vm.disk`).
- [framework-consult.md](framework-consult.md) — escalating a best-practice question; this doc is the standard one such consult produced.
- [convenience-scripts.md](convenience-scripts.md) — the `cb-*` container-helper convention that `cb-df` follows.
- [../../CLAUDE.md](../../CLAUDE.md) — the multi-project DooD vision and the conventions this standard plugs into.

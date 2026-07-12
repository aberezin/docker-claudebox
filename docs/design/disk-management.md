# Design: Docker disk management under the per-project VM

**Status:** Accepted standard — produced by a [framework consult](framework-consult.md).
**Applies to:** every claudebox project (any claudebot that builds/pulls docker images).
See [per-project-vm.md](per-project-vm.md) for the VM model this builds on.

## Summary

Each claudebox project runs in **its own Colima VM with a single overlay disk**. That
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
  effective habit. `docker image prune` alone (which is all the host `claudebox vm gc`
  does per VM) does **not** touch build cache.
- **Detached workloads pin their images.** `docker image prune -af` won't remove an
  image a running container uses — stop throwaway test containers first.
- Prefer `builder prune` / `image prune` (surgical) over `system prune -a` (blunt) in a
  live session, so you don't nuke a base image you're about to reuse.

## In-VM disk visibility

You cannot manage what you cannot see, and the host tools (`claudebox vm usage`) are on
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
| `claudebox vm usage` | per-VM **actual** Mac footprint (VM disks are sparse) + orphaned disks |
| `claudebox vm gc` | reclaim: delete orphaned lima disks + prune images **and build cache** + `fstrim` running cb-* VMs so freed guest blocks return to macOS |

Note the sparse-disk subtlety (see [per-project-vm.md](per-project-vm.md)): pruning
*inside* the guest frees guest space immediately, but the **host** raw disk file keeps
its high-water mark until a TRIM — which `claudebox vm gc` issues via `fstrim`. So "I
pruned but the Mac still shows the VM as huge" is expected until `gc`.

## VM disk sizing

The per-project disk is set in `.claudebox/config.yml`:

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
  Change `vm.disk`, then `claudebox down` and start again (a bigger `disk:` on an
  existing VM is not applied live).
- The `cb-infra` image-store VM is separate (`CLAUDEBOX_INFRA_DISK`, install-time only,
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
| `ENOSPC: no space left on device, mkdir '/tmp/claude-501'` on **every** Bash call | Shared overlay full; Bash tool can't create its scratch dir | You can't shell out. Use the **Write-tool escape** (below) to report, then have the human run `docker system prune -af` / `claudebox vm gc` on the Mac. Bash recovers once `/` has room. |
| `df -h /` "Use%" in the 90s mid-session | Build cache / unused images accumulating | `docker builder prune -f`, then `docker image prune -af` |
| Pruned inside the VM but `claudebox vm usage` still shows it huge | Sparse host disk keeps its high-water mark until TRIM | `claudebox vm gc` (fstrims running cb-* VMs) |
| Disk fills fast on an image-heavy project even with pruning | 60 GiB too small for the workload | Raise `vm.disk` in `.claudebox/config.yml`, `claudebox down`, restart |
| `docker image prune` frees little though the disk is full | Build **cache** (not images) is the hog; `image prune` doesn't touch it | `docker builder prune -f` (or `docker system prune -f`) |

## Graceful ENOSPC & the out-of-band report path

When the disk is already full, **Bash is dead** — so a "report path that doesn't depend
on Bash" must **not be a shell command**. `cb-report-bug` and `cb-consult` are Bash
scripts and will themselves fail with ENOSPC.

**The escape: your Write tool still works.** It writes a file directly, without spawning
a shell or a tempdir. Both the framework-bug drop and the consult store are **host
bind-mounts** present in every container:

- Framework bugs → `/home/claude/framework-bugs/` (env `CLAUDEBOX_FRAMEWORK_BUGS_DIR`)
- Consults → `/home/claude/framework-consult/` (env `CLAUDEBOX_CONSULT_DIR`)

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
collection path `claudebox framework-bugs`). Then tell the human to reclaim disk from the
Mac (`docker system prune -af` / `claudebox vm gc`); Bash recovers once `/` has room.

The **bare, guidance-free ENOSPC** message the Bash tool surfaces (a raw Node error with
no hint about the VM disk) is a **Claude Code upstream** concern, not something claudebox
can fix in the tool itself. claudebox mitigates it with this doc, the baked "Disk
discipline" guidance, `cb-df`, prune-aware `vm gc`, and an optional startup disk MOTD —
but the in-tool message improvement belongs upstream.

## What claudebox bakes in

- **Baked container guidance** — a "Disk discipline" section in the auto-generated
  container `CLAUDE.md` (`entrypoint.sh` → `CLAUDEMD_NOTES`): watch `df -h /`, prune
  cadence, and the Write-tool report escape — so every claudebot self-diagnoses.
- **`cb-df`** — the in-VM disk snapshot helper (see [In-VM disk visibility](#in-vm-disk-visibility)),
  following the [`cb-*` convention](convenience-scripts.md).
- **Prune-aware `claudebox vm gc`** — the host reclaim command also prunes build cache
  per VM (not only dangling images), because build cache is the real accumulator.

If any of this bites you or is missing, that's framework feedback: open a
[consult](framework-consult.md) (best-practice question) or `cb-report-bug` (defect) —
or, if Bash is down, Write the report file directly as above.

## See also

- [per-project-vm.md](per-project-vm.md) — the per-project Colima VM model, sparse disks, `vm usage` / `vm gc`, and the config schema (`vm.disk`).
- [framework-consult.md](framework-consult.md) — escalating a best-practice question; this doc is the standard one such consult produced.
- [convenience-scripts.md](convenience-scripts.md) — the `cb-*` container-helper convention that `cb-df` follows.
- [../../CLAUDE.md](../../CLAUDE.md) — the multi-project DooD vision and the conventions this standard plugs into.

# Upstream sync — audit method + latest finding

**Status:** Living record. Re-run periodically. Last audit: 2026-07-17 (issue #8).

**Applies to:** the fork's relationship with `psyb0t/docker-claudebox` upstream.

## TL;DR (2026-07-17 audit)

**Zero cheap merges.** Upstream and this fork have architecturally diverged. At upstream
`v2.0.0` (2026-07-04, commit `26c3bf8`) psyb0t rebased claudebox onto a shared
`aicodebox` substrate — a full architectural fork. Every subsequent upstream commit
(v2.0.1 → v2.0.10) sits on that substrate; none of them land cleanly on this fork's
structure. The one pre-rebase commit (`f97ee89`, v1.14.1) bumps a pinned Claude CLI
version, but this fork uses the native Claude installer, not a pinned CLI, so it's not
applicable either.

**Policy going forward**: audit again if psyb0t ships something notable in release
notes; expect zero merges by default. Neither codebase is "wrong" — they've just chosen
different directions (upstream: shared base image + cross-project mode reuse; fork:
macOS + per-project Colima VM + framework-Claude tooling + `harness` namespace +
dridock rebrand).

## Audit method

Reproducible; keep this section aligned with what actually works.

```bash
# 1. one-time: add upstream as a remote (safe — separate tag/branch namespace).
git remote add upstream https://github.com/psyb0t/docker-claudebox.git
git fetch --tags upstream

# 2. find the actual last common ancestor (NOT the tag the fork note claims).
FORK_POINT="$(git merge-base origin/master upstream/master)"
git describe --tags "$FORK_POINT"        # e.g. v1.14.0-1-g6b71854

# 3. enumerate upstream commits since the fork point.
git log "$FORK_POINT"..upstream/master --oneline

# 4. for each commit, decide (a) cheap-merge worth it / (b) merge-worthy but expensive /
#    (c) skip. Read the code, not just the message; upstream commits are release-tagged
#    so the message can be misleading.
git show --stat <sha>
git show <sha> -- <specific file>

# 5. cherry-pick anything in (a), referencing upstream sha in the CHANGELOG entry.
git cherry-pick <sha>
```

## 2026-07-17 audit — classification (12 upstream commits post-fork-point)

Fork point: `6b71854` (upstream `v1.14.0-1-g6b71854`).

| Upstream commit | Tag | Classification | Why |
|---|---|---|---|
| `f97ee89` | v1.14.1 | **Skip** | Bumps pinned Claude CLI to 2.1.197. Fork uses the native Claude installer (no pinned CLI), so not applicable. |
| `26c3bf8` | v2.0.0 | **Skip (structural rebase)** | Full architectural rebase onto `psyb0t/aicodebox` base image. Paths, env vars, endpoints, MCP tools all renamed. Fork's direction is orthogonal — Colima-specialized, not shared-base. |
| `93720e0` | v2.0.1 | **Skip (post-rebase)** | CI fix + doc sync + uv/lint hardening on the aicodebox substrate. Not applicable to fork. |
| `14a39b8` | v2.0.2 | **Skip (post-rebase)** | Dockerfile.full BuildKit gpg failure fix — aicodebox-substrate Dockerfile, not fork's. |
| `05c7572` | v2.0.3 | **Skip (post-rebase)** | Restores `CLAUDE_CONFIG_DIR` for login/theme persistence — aicodebox path layout, not fork's. |
| `933d19d` | v2.0.4 | **Skip (post-rebase)** | Build order fix: build latest-full after base so env inherits — aicodebox layered image, not fork's. |
| `68a43bb` | v2.0.5 | **Skip (post-rebase)** | Wrapper honors `CLAUDEBOX_FULL` env — aicodebox variant selection, not fork's. |
| `533dd22` | v2.0.6 | **Skip (post-rebase)** | Restores interactive/one-shot defaults (auto-resume, permission bypass, system-hint) that the rebase inadvertently changed. Not applicable — fork never had that regression. |
| `0137f30` | v2.0.7 | **Skip (post-rebase)** | Makes `Dockerfile.full npm install` resilient to transient registry failures — aicodebox Dockerfile.full, not fork's. Fork's `Dockerfile` has a similar concern but different resolution path (baked cb-infra + `--repair`). |
| `205dec3` | v2.0.8 | **Skip (post-rebase)** | Persists `CLAUDEBOX_FULL` image-variant choice into the wrapper — aicodebox variant concept, not applicable (fork has `CLAUDEBOX_MINIMAL`, single-lane). |
| `177de4b` | v2.0.9 | **Skip (post-rebase)** | Puts `go` on PATH in the full image's non-login shells. Fork's `Dockerfile` already has this concern handled differently (baked `go` at image build; PATH set via full image's own layer). Could double-check the fork isn't leaking a similar bug — not an "cherry-pick this commit" candidate either way. |
| `4cae961` | v2.0.10 | **Skip (post-rebase)** | Fixes a false "claude missing or broken" startup warning on the aicodebox substrate. Fork's entrypoint doesn't emit that warning. |

**Result: 0 (a), 0 (b), 12 (c).** No cherry-picks, no releases from this audit.

### Optional follow-up (not an upstream merge)

`v2.0.9`'s concern (`go` on PATH in non-login shells) is a general Docker gotcha. Worth a
5-minute sanity check on this fork's `Dockerfile` to confirm `go` (and `python`, `node`,
etc.) are on PATH for `docker exec -it <container> bash` (non-login). Not tracked as an
issue unless the check finds something.

## Tag namespace collision

Only one tag name collides between `origin` (aberezin fork) and `upstream` (psyb0t):
**`v2.0.0`** — the two lineages both chose that name for their post-1.x kickoff.

- Fork's `v2.0.0` = `4b3845e` (semver-establishing commit, 2026-07-06).
- Upstream's `v2.0.0` = `26c3bf8` (aicodebox rebase, 2026-07-04).

**Not a functional problem** — `git fetch --tags` (default, no `--force`) doesn't
overwrite existing tags; whoever added the tag first wins locally. For anyone with both
remotes, the fork's tags won at the point they were first added. Everything else in the
fork's line (2.0.1 → current) is a distinct tag name from upstream's line (2.0.1 → 2.0.10
also exist, but this fork ships those commit slots as its OWN v2.0.1 etc. — the fork's
v2.0.1 doesn't exist as of 2026-07-17; fork commits started at v2.0.0 then leapt to
v2.2.0 per the CHANGELOG). Post-2.15.0 both lines coincidentally passed through the
same version numbers, but only `v2.0.0` is the true shared name.

**Disambiguating from a shell**:

```bash
# fork's tag pointer
git ls-remote --tags origin  'v2.0.0'
# upstream's tag pointer
git ls-remote --tags upstream 'v2.0.0'
```

If future collisions arise (either lineage gets close to the other's shipped version
number), consider prefixing tags on push (`aberezin-v2.X.Y`) or filing an issue to
discuss policy. Not urgent — the collision surface is minimal today.

## Policy for future audits

- **Cadence**: no fixed cadence. Re-run when psyb0t announces a notable release, or when
  someone raises "should we look at upstream?" in an Issue. Adding it to a calendar
  reminder is overkill given the current zero-yield result.
- **Time-box**: 30–60 minutes per audit. If it takes longer, upstream's diverged even
  further and the audit's already answered itself.
- **Deliverable**: update this doc with a new dated section under "Latest audit" style.
  Preserve prior audit sections as a history so anyone reading later sees the trajectory.
- **When to un-fork policy**: if psyb0t un-rebases (unlikely) or the fork adopts the
  aicodebox substrate (unlikely), revisit and possibly re-establish cherry-pick flow.
  Until then, upstream is watch-only.
- **Non-code learnings still valuable**: if an upstream commit teaches something about
  a shared bug class (e.g., v2.0.7's transient-registry-failure resilience) that could
  affect this fork *even at a different code location*, note it here or file an issue —
  don't cherry-pick, but don't lose the lesson either.

## See also

- [`CHANGELOG.md`](../../CHANGELOG.md) — the fork note at the top has been updated
  (2026-07-17) to reflect that upstream also has a 2.x line and only `v2.0.0` collides.
- [versioning.md](../versioning.md) — semver rules; a cherry-picked upstream commit
  would land under whichever bump the fork's changes deserve, not upstream's tag.
- [`README.md`](../../README.md) § "What's different in this fork" — the categories of
  divergence that inform "skip" classification in the table above.
- Issue [#8](https://github.com/aberezin/docker-claudebox/issues/8) — the issue this
  audit closes.

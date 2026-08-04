# Versioning & releases

This fork uses [semantic versioning](https://semver.org) on its **own** version
line, starting at **2.0.0** (2026-07-06). We deliberately start **above** upstream
claudebox's highest pre-fork tag (`v1.11.0`) so the fork's versions and tags never
collide with the inherited upstream history and sort cleanly above it — which also
keeps things coherent if upstream ever pulls from us or we pull from them. Upstream's
`1.x` history is preserved in `CHANGELOG.md` below the fork's entries.

## Why a version matters here

The host wrapper (`wrapper.sh`, installed as `dridock` in 3.0+ — was `claudebox` in 2.x) and the built image
(entrypoint + baked helpers like `cb-browser`) share an **IPC contract**: sidecar
filenames/formats (`.<container>-auth` / `-secrets` / `-args` / …), forwarded env,
the `cb-browser` `/out` convention, secrets injection. If they drift — you update
one but not the other — you get subtle, confusing breakage. The version makes drift
**detectable**.

## Source of truth

- **`VERSION`** (repo root) holds the current semver — the single source of truth.
- **`wrapper.sh`** embeds it as `DRIDOCK_VERSION` (3.0+; was `CLAUDEBOX_VERSION` in
  2.x); a unit test (`tests/test_cbvm.sh`) asserts the two match, so they can't
  silently diverge.
- The **image** stamps it at build time via `Dockerfile` `ARG`/`ENV`/`LABEL
  org.dridock.version` (3.0+; the `checkversion` reader still falls back to the
  legacy `org.claudebox.version` label for one deprecation cycle), passed by
  `make` / `install.sh` as `--build-arg DRIDOCK_VERSION=…`.

## Checking for drift

- `dridock version` — print the host wrapper's semver.
- `dridock checkversion` — compare the wrapper against the version baked into the
  claudebot image (both the `cb-infra` build/store image and this project's VM), and
  warn on drift with direction-specific guidance (rebuild the image / reinstall the
  wrapper). Read-only; never boots a VM. Images built before versioning read as
  `unstamped` until the next `make build`.

## When to bump (semver)

- **PATCH** (`2.0.0 → 2.0.1`) — fixes/docs, no contract change.
- **MINOR** (`2.0.0 → 2.1.0`) — new features, **or a backward-compatible (additive)
  change to the host↔container IPC contract**: a new sidecar file / forwarded env /
  baked helper that a newer peer adds and an older peer safely ignores (e.g. adding
  the `-secrets` sidecar).
- **MAJOR** (`2.0.0 → 3.0.0`) — a **breaking** contract change: a renamed/removed
  sidecar, or a changed format/semantics an older peer would misread. This is what
  `checkversion`'s drift warning most wants to catch.

## Release steps

1. Bump **`VERSION`** and the `DRIDOCK_TS_VERSION` constant in **`dridock-ts/src/domain/dridockVersion.ts`** to the
   same value (the sync test enforces this).
2. Add a **`CHANGELOG.md`** entry under a new `## [X.Y.Z] — <date>` heading — one
   entry per bump (see the changelog policy below).
3. Commit, then **tag**: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push it
   (`git push <remote> vX.Y.Z`). **Fork gotcha:** the clone inherited upstream's
   `v0.x`–`v1.x` tags locally, so `git tag vX.Y.Z` may collide with an ancient
   upstream tag pointing at the wrong commit. Verify with `git rev-list -n1 vX.Y.Z`,
   and use `git tag -f -a vX.Y.Z HEAD` (then `git push --force <remote> vX.Y.Z`) if it
   resolved to an upstream commit. The remote fork only carries the tags we push.
4. `make build` to stamp the image; reinstall the wrapper (`./install.sh`, or
   `install -m 755 wrapper.sh ~/.local/bin/dridock`). `dridock checkversion`
   should then read **in sync**.

## Branch naming — `<issue#>-<slug>`

Work branches are named for the **GitHub issue they close**, issue number first:

```
62-mcp-pin-api-mode
58-container-xdg-persistence
56-container-side
46-agent-teams
```

The number goes first so `git branch -r` sorts and greps by issue, and so anyone
looking at a branch can find the *why* without reading the diff. The slug is a short
kebab-case hint, not a description — the issue holds the detail.

Rules:

- **One issue per branch.** If a fix spans two issues, either they're really one issue
  (merge them) or they're really two branches. Bundling means neither issue's history
  is reviewable on its own.
- **File the issue first.** A branch with no issue number has nowhere to record the
  problem statement, the options considered, or the verification — see
  [Filing an issue](#filing-an-issue) below.
- **Reference the issue in every commit** on the branch (`fix(#62): …`), so the fix is
  traceable from `git log` alone once the branch is gone.

Two pre-3.0 branches (`wrapper-typescript-rewrite`, `dridock-skill-statusline`) predate
this convention. Don't take them as precedent.

Merging is **fast-forward** where possible (`git merge --ff-only`); check with
`git merge-base --is-ancestor origin/master <branch>` before assuming it isn't.
Note that landing anything on `master` while a long-lived branch is open puts that
branch out of FF range, so prefer to hold unrelated commits until it merges.

### Who merges

**Whoever owns the branch merges it, and says so on the issue** — a close-note naming
the merge commit (and tag, if one was cut). The reviewer signs off; they do not merge.

"Signed off" does not say who merges, and that ambiguity has two failure modes, both
seen on #62/#64: each agent waits for the other, or both merge and one clobbers.
Ownership decides *who*; it does not decide *whether it has been verified* — a branch
still needs its sign-off before its owner merges it.

### Claiming something is verified

**Name the environment, or you haven't verified it.** "Verified on real runs" is a
weaker claim than it sounds when this project ships into two runtimes — macOS/colima
on the host and Linux/`docker` in the container — and most bugs live in exactly one.

Say *macOS + colima* or *Linux + docker backend*, and say which you did **not** cover.
Two separate bugs in one day were invisible to one side and obvious from the other:

- **#63** — the runner counted visibly-failing tests as PASSED. Only reachable on the
  `docker` backend, because the test that exposed it legitimately passes under colima.
- **#66** — elapsed time vanished entirely because Linux `procps-ng` left-pads
  `ps -o etime=` and BSD `ps` does not. Verified working on macOS; shipped broken for
  the container, which is the primary target.

Neither was found by review. Both were found by the *other* runtime running the same
code. When you cannot exercise a path, say so and hand it to whoever can — that is a
result, not an admission.

## Changelog policy

Every version bump gets a `CHANGELOG.md` entry. Detailed fork changes **between the
upstream fork point and 2.0.0 were not recorded** in the changelog (they live in the
git history / are summarized in the README's "What's different in this fork"); the
changelog is **authoritative from 2.0.0 onward**.

## Backlog / issue tracking

Work not yet shipped lives in **GitHub Issues on the fork**:
[github.com/aberezin/docker-claudebox/issues](https://github.com/aberezin/docker-claudebox/issues).
That's the single source of truth for open work — the running list of proposals,
open design decisions, and residual TODOs. If it's not filed there, it isn't tracked.

### Standard labels

| Label | Meaning |
|---|---|
| `3.0-bundle` | Queued for the `2.x → 3.0` breaking migration (dridock rename, host↔container command unification, plugin system, etc.). Don't ship in isolation. |
| `framework-dev` | Ergonomics for developing the harness itself (from inside a claudebot or on the Mac). |
| `browser-bridge` | CDP bridge, Chrome control, browser testing. |
| `backlog` | Filed from `.dridock/BRIEF.md`'s handoff log during a working session (as opposed to a fresh user-reported issue). |
| `enhancement` / `bug` / `documentation` | Standard GitHub defaults. Use them. |

Custom labels are managed with `gh label create --repo aberezin/docker-claudebox …`.
Enable Issues on a new fork with `gh repo edit --enable-issues` (once per repo — the
fork inherits upstream's "issues disabled" default).

### Filing an issue

Use `gh issue create` (from anywhere with a working `GH_TOKEN` — the Mac, or a
framework-dev claudebot with fresh secrets), and follow the template shape:

```
## Problem            — what's the concrete symptom / gap
## Options            — the two or three shapes worth considering, with tradeoffs
## Sizing / timing    — small / medium / big; urgent or queue for a bundle
## Related            — links to prior commits, CHANGELOG entries, sibling issues
```

A backlog item is complete when a reader can act on it without asking a follow-up
question. Copy-pasting a paragraph from `BRIEF.md` is fine — that log's TODO entries
are already written in this shape.

### Closing an issue

Link the commit that ships the work with `Fixes #N` in the commit body (or as a PR
title if you're going through a PR). GitHub auto-closes the issue when the commit
lands on `master`. Reference the same issue number in the `CHANGELOG.md` entry so the
audit trail is bidirectional.

### Relationship to `.dridock/BRIEF.md`

The BRIEF's Progress/handoff log stays the **narrative** — what happened this session,
what's next, what's undecided *right now*. When a decision solidifies into "we should
do this eventually," file it as an issue and cross-reference from the log entry. The
log is a scratchpad; the issue tracker is the ledger.

## See also

- `CHANGELOG.md` — the running record of version bumps.
- [github.com/aberezin/docker-claudebox/issues](https://github.com/aberezin/docker-claudebox/issues) — the backlog.
- [Per-project VM lifecycle](design/per-project-vm.md) — where `version` /
  `checkversion` sit among the VM commands.
- [bootstrap.md](design/bootstrap.md) — where `.dridock/BRIEF.md` fits in the
  project lifecycle (the log side of the backlog / log split).
- The top-level `CLAUDE.md` "Conventions worth knowing" — the one-line rule.

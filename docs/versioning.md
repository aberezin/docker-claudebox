# Versioning & releases

This fork uses [semantic versioning](https://semver.org) on its **own** version
line, starting at **2.0.0** (2026-07-06). We deliberately start **above** upstream
claudebox's highest pre-fork tag (`v1.11.0`) so the fork's versions and tags never
collide with the inherited upstream history and sort cleanly above it — which also
keeps things coherent if upstream ever pulls from us or we pull from them. Upstream's
`1.x` history is preserved in `CHANGELOG.md` below the fork's entries.

## Why a version matters here

The host wrapper (`wrapper.sh`, installed as `claudebox`) and the built image
(entrypoint + baked helpers like `cb-browser`) share an **IPC contract**: sidecar
filenames/formats (`.<container>-auth` / `-secrets` / `-args` / …), forwarded env,
the `cb-browser` `/out` convention, secrets injection. If they drift — you update
one but not the other — you get subtle, confusing breakage. The version makes drift
**detectable**.

## Source of truth

- **`VERSION`** (repo root) holds the current semver — the single source of truth.
- **`wrapper.sh`** embeds it as `CLAUDEBOX_VERSION`; a unit test
  (`tests/test_cbvm.sh`) asserts the two match, so they can't silently diverge.
- The **image** stamps it at build time via `Dockerfile` `ARG`/`ENV`/`LABEL
  org.claudebox.version`, passed by `make` / `install.sh` as `--build-arg`.

## Checking for drift

- `claudebox version` — print the host wrapper's semver.
- `claudebox checkversion` — compare the wrapper against the version baked into the
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

1. Bump **`VERSION`** and the `CLAUDEBOX_VERSION` constant in **`wrapper.sh`** to the
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
   `install -m 755 wrapper.sh ~/.local/bin/claudebox`). `claudebox checkversion`
   should then read **in sync**.

## Changelog policy

Every version bump gets a `CHANGELOG.md` entry. Detailed fork changes **between the
upstream fork point and 2.0.0 were not recorded** in the changelog (they live in the
git history / are summarized in the README's "What's different in this fork"); the
changelog is **authoritative from 2.0.0 onward**.

## See also

- `CHANGELOG.md` — the running record of version bumps.
- [Per-project VM lifecycle](design/per-project-vm.md) — where `version` /
  `checkversion` sit among the VM commands.
- The top-level `CLAUDE.md` "Conventions worth knowing" — the one-line rule.

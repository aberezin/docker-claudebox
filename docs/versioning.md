# Versioning & releases

This fork uses [semantic versioning](https://semver.org) on its **own** version
line, independent of upstream claudebox's `1.x` history. It starts at **0.1.0**
(2026-07-06); the upstream history is preserved in `CHANGELOG.md` below the fork's
entries.

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

- **PATCH** (`0.1.0 → 0.1.1`) — fixes/docs, no contract change.
- **MINOR** (`0.1.0 → 0.2.0`) — new features, **or any change to the host↔container
  IPC contract** (new/renamed sidecar file, changed forwarded env, changed baked
  helper behavior). While in `0.x`, MINOR is the "the contract changed" signal.
- **MAJOR** (`→ 1.0.0`) — first stable release / the contract is declared stable;
  thereafter breaking contract changes bump MAJOR.

## Release steps

1. Bump **`VERSION`** and the `CLAUDEBOX_VERSION` constant in **`wrapper.sh`** to the
   same value (the sync test enforces this).
2. Add a **`CHANGELOG.md`** entry under a new `## [X.Y.Z] — <date>` heading — one
   entry per bump (see the changelog policy below).
3. Commit, then **tag**: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push it
   (`git push <remote> vX.Y.Z`).
4. `make build` to stamp the image; reinstall the wrapper (`./install.sh`, or
   `install -m 755 wrapper.sh ~/.local/bin/claudebox`). `claudebox checkversion`
   should then read **in sync**.

## Changelog policy

Every version bump gets a `CHANGELOG.md` entry. Detailed fork changes **between the
upstream fork point and 0.1.0 were not recorded** in the changelog (they live in the
git history / are summarized in the README's "What's different in this fork"); the
changelog is **authoritative from 0.1.0 onward**.

## See also

- `CHANGELOG.md` — the running record of version bumps.
- [Per-project VM lifecycle](design/per-project-vm.md) — where `version` /
  `checkversion` sit among the VM commands.
- The top-level `CLAUDE.md` "Conventions worth knowing" — the one-line rule.

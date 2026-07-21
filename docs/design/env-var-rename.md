# Env-var rename compat — the standard

**Status:** Shipped in 3.2.1 (2026-07-21) resolving [issue #16](https://github.com/aberezin/docker-claudebox/issues/16). Framework consult `2026-07-21T01-31-28-unknown`.

## Problem

3.0 renamed the harness's user-facing env prefix from `CLAUDEBOX_*` to `DRIDOCK_*`
(design in [3.0-migration.md](3.0-migration.md)). The changelog promised "all of 3.x
line accepts `CLAUDEBOX_*` env" — a compat guarantee for the whole deprecation cycle.

That guarantee was implemented on the **host side** by `wrapper.sh:_dridock_alias`:
for every renamed pair, if the user set only the legacy name on the Mac, the wrapper
copied it into the canonical name so all in-file reads worked uniformly. Good.

But the same guarantee was **NOT** in force on the **container-internal** side. The
entrypoint exports only `DRIDOCK_*` (via sidecars). Baked `cb-*` helpers, written
before the rename, still read `CLAUDEBOX_*` at every site (`cb-browser`, `cb-consult`,
`cb-report-bug`, `cb-harness-watch-consults`, `cb-host-shim`). Nothing bridged them.
A fresh 3.x session's `cb-browser cdp` hard-failed with "no host CDP bridge" even
though the bridge was fully up — the helper checked `CLAUDEBOX_HOST_CDP_URL` and got
empty, while the wrapper had exported `DRIDOCK_HOST_CDP_URL`.

## Decision

**Both sides — host wrapper and container entrypoint — run a symmetric env-var
aliaser at their own boot, driven by a shared map file.** Anywhere either name is
set, the other name gets the same value; either name unset stays unset. Users and
helpers can read either name for the whole 3.x line. 4.0 deletes the map + both
aliasers in one commit.

### Why this shape

Three candidates were on the table (from the consult):

**A. Entrypoint exports BOTH names ad-hoc at every injection site.** Rejected —
that's the same scavenger hunt the wrapper avoided by centralizing on
`_dridock_alias`. Do it in ONE function, with the rename map as data.

**B. Per-helper compat check** (`: "${CLAUDEBOX_X:=${DRIDOCK_X:-}}"` at each read
site). Rejected — this is the pattern that just leaked (`cb-browser` never got the
check, every new helper repeats the error, every future rename multiplies surface).

**C. Only new names, plus a boot-time deprecation warning.** This is the *4.0
endpoint*, not the 3.x behavior. During the deprecation cycle the compat guarantee
includes container-internal reads.

The shipped shape is a hybrid of A and C: A's symmetry (map-driven, single function
per side) for 3.x, transitioning to C's clean state (map + aliasers deleted) in 4.0.

## Implementation

### The map (`env-rename.map`, repo root)

One `NEW LEGACY` pair per line; blank/comment lines ignored. **Single source of
truth** — every rename touches exactly this file. Two callers read it:

- **Host: `wrapper.sh`** at source-time, via `_dridock_alias`. Copies legacy → new
  when only the legacy is set. Lookup order: (a) next to the wrapper (dev/source
  layout — where the map lives in the repo checkout), (b) `$XDG_DATA_HOME/dridock/
  env-rename.map` (installed layout — put there by `install.sh`), (c) container's
  baked location `/usr/local/share/dridock/env-rename.map` (harmless — this branch
  only runs on the Mac, but included for a container that ever runs `wrapper.sh`
  directly, e.g. for framework-dev).
- **Container: `entrypoint.sh`** at boot, via `_dridock_alias_env`. Mirrors BOTH
  directions: if only `DRIDOCK_X` is set, exports `CLAUDEBOX_X`; if only
  `CLAUDEBOX_X` is set, exports `DRIDOCK_X`; if both, leave alone (canonical was
  already the source of truth). Lookup: `/usr/local/lib/dridock/env-rename.map`
  (baked by `Dockerfile`).

### Sidecar-load ordering (matters)

`entrypoint.sh` runs the aliaser **AFTER** `_load_env_sidecar auth|secrets|cdp|
vmip|hostagent`. The sidecars are the durability layer — they carry the canonical
`DRIDOCK_X` and can explicitly UNSET it (empty sidecar entry means "cleared
host-side," e.g. bridge-down clearing `DRIDOCK_HOST_CDP_URL`). If the aliaser ran
BEFORE, a stale `CLAUDEBOX_X` baked into an older `docker run -e` from before
3.1.0's secrets-off-argv fix could shadow the intentionally-empty sidecar entry
and RE-CREATE a canonical value the wrapper wanted cleared. Post-sidecar: sidecar
wins, its value propagates.

### Adding a new rename (going forward)

One line in `env-rename.map`. That's it. No Bash edits anywhere else. Every
existing caller — every claudebot's `cb-*` helpers, every user's `init.d` hooks,
every doc example — gets the compat automatically at both boundaries. The next
rebrand ships in one commit.

## Backward-compat window

Documented in [3.0-migration.md § Backward compat window](3.0-migration.md#backward-compat-window):
one deprecation cycle covering all of 3.x. The map file, `_dridock_alias`
(wrapper), and `_dridock_alias_env` (entrypoint) are the mechanism that implements
that promise. **4.0 removes all three simultaneously.** At that point:
- `CLAUDEBOX_X` env vars users set on the Mac stop being copied into `DRIDOCK_X`
  → wrapper doesn't see them.
- `CLAUDEBOX_X` reads in baked helpers stop being satisfied by
  aliased-from-`DRIDOCK_X` → those reads silently unset.
- Users who never updated their scripts break; scripts written in `DRIDOCK_X`
  keep working with no change.

So: users have all of 3.x to update, and every `cb-*` helper edited between now
and 4.0 should be migrated from `${CLAUDEBOX_X:-}` to `${DRIDOCK_X:-${CLAUDEBOX_X:-}}`
opportunistically (the shim removes urgency, but 4.0's shim-removal shouldn't
strand anything).

## Testing

`tests/test_env_rename_compat.sh` (pure bash, no docker) sources the
container-side aliaser function against a scratch map and asserts:
- `DRIDOCK_X` set alone → `CLAUDEBOX_X` mirrored
- `CLAUDEBOX_X` set alone → `DRIDOCK_X` mirrored
- Both set → neither clobbered
- Neither set → both stay unset
- Blank / comment lines in the map ignored
- Map missing → no-op (best-effort semantics)

Also asserts the map file itself parses: every non-comment line has exactly two
whitespace-separated tokens (name pairs), and both tokens are valid shell
identifiers.

## See also

- [Issue #16](https://github.com/aberezin/docker-claudebox/issues/16) — the
  cb-browser CDP failure that triggered the standard.
- Framework-consult thread `2026-07-21T01-31-28-unknown` — the design conversation.
- [3.0-migration.md](3.0-migration.md) — where the rename happened + backward-compat
  window that this doc implements.
- [convenience-scripts.md](convenience-scripts.md) — `cb-*` helper convention;
  new helpers should read `${DRIDOCK_X:-${CLAUDEBOX_X:-}}` at each site (belt +
  suspenders — the shim handles the CLAUDEBOX_X read, this makes the intent
  explicit so 4.0's shim-removal doesn't strand the helper).
- [framework-consult.md](framework-consult.md) — where consults like this one
  turn into standards.

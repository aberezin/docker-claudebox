# Roadmap — planned removals and breaking changes

Dridock's forward commitments. This file exists because a deprecation promise
written in prose **does not hold on its own**: `entrypoint.sh` told every
claudebot that legacy `CLAUDEBOX_*` names would "go away in 4.0", we shipped
4.0 through 4.4.0 with the aliaser still live, and nothing noticed until a
namespace sweep found it ([#82](https://github.com/aberezin/docker-claudebox/issues/82)).

So every commitment here carries an **enforcing test**. The test fails the build
when the release that was supposed to do the removal arrives and the removal has
not happened. A deadline nobody can miss beats a deadline everybody means to keep.

## Committed removals

| Release | What goes away | Enforced by |
|---|---|---|
| **5.0.0** ✅ done | Legacy `CLAUDEBOX_*` / `CLAUDE_*` env tiers, the container env aliaser, and silent `.claudebox/` directory fallbacks. | `tests/test_deprecation_deadlines.sh` |
| **6.0.0** | The `.claudebox/` → `.dridock/` migration path: the `dridock migrate` verb, `autoMigrateIfNeeded`, and the five migrators under `dridock-ts/src/services/migrators/`. | `tests/test_deprecation_deadlines.sh` |

### Why 6.0 and not 5.0 for the migrators

5.0 stops *silently* honouring legacy paths — a `.claudebox/`-only project now
gets a loud error naming `dridock migrate` instead of quietly working. The
migrators are what that error points at, so removing them in the same release
would delete the bridge and the destination together, stranding anyone who had
not migrated yet.

One major version of overlap gives every project a release in which the old
layout is clearly broken **and** the fix is one documented command. At 6.0 the
assumption is that anything still on `.claudebox/` is abandoned.

## How the enforcement works

`tests/test_deprecation_deadlines.sh` reads `VERSION`, and for each commitment
whose deadline major has been reached, asserts the thing is actually gone. While
the deadline is in the future it asserts the opposite — that the code being
promised for removal still exists — so a commitment cannot rot into a stale
entry describing something already deleted.

Adding a commitment means adding a row above **and** a check in that test. A row
without a check is the failure mode this whole file exists to prevent.

## See also

- [versioning.md](versioning.md) — semver rules and the release process.
- [design/env-var-rename.md](design/env-var-rename.md) — the 3.0 rename these removals conclude.
- [../CHANGELOG.md](../CHANGELOG.md) — what actually shipped.

| `team:` optional in `.dridock/agents.yml` | 6.0.0 | `dridock team dir` errors without it; absence warns in 5.x | `tests/test_deprecation_deadlines.sh` |

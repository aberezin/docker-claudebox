#!/usr/bin/env bash
# #103 — VERSION and DRIDOCK_TS_VERSION must agree.
#
# `docs/versioning.md`'s release steps said, from the TS port until #103, that
# the two are kept in lockstep "(the sync test enforces this)". No such test
# existed. The only thing touching both was
# dridock-ts/src/cli/commands/CheckversionCommand.test.ts, which seeds a FAKE
# /repo/VERSION from the constant into an InMemoryFileSystem — that exercises
# `checkversion`'s own logic, not the real pair on disk, so the two files could
# silently diverge.
#
# They are a build-time contract: VERSION is what `make`/`install.sh` pass as
# --build-arg DRIDOCK_VERSION (stamped into the image as
# `org.dridock.version`), and DRIDOCK_TS_VERSION is what the host binary
# reports. Diverge them and `dridock checkversion` reports host↔image drift
# that isn't real — a false alarm about the one thing it exists to detect, and
# noticed long after the commit that caused it.
#
# A doc asserting enforcement it doesn't have is worse than saying nothing: it
# tells the next person not to check. Same reasoning as
# tests/test_deprecation_deadlines.sh — a rule nobody can forget beats a rule
# everybody means to keep.
#
# Host-only: two file reads, no Docker, no token.
#
# Self-registers into ALL_TESTS. Also directly runnable:
#   bash tests/test_version_sync.sh
set -u

test_version_sync() {
    local PASS=0 FAIL=0
    ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
    bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

    # One statement, not `local REPO; REPO="${REPO:-…}"`: the bare `local`
    # resets REPO to empty first, so an override from the environment was
    # silently dropped and the test checked the real repo instead (#108 review).
    # shellcheck disable=SC2155  # the subshell's rc isn't what we'd act on
    local REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    local vfile="$REPO/VERSION"
    local tsfile="$REPO/dridock-ts/src/domain/dridockVersion.ts"

    echo "--- #103 VERSION / DRIDOCK_TS_VERSION sync ---"

    # Both sides must be READABLE before any comparison means anything. An
    # empty-vs-empty match would pass while checking nothing.
    local vraw tsraw
    if [ -f "$vfile" ] && [ -s "$vfile" ]; then
        vraw="$(tr -d '[:space:]' < "$vfile")"
        ok "VERSION is present and non-empty ($vraw)"
    else
        bad "VERSION missing or empty at $vfile — the comparison below would be vacuous"
        echo "  #103 version sync: $PASS passed, $FAIL failed"
        return 1
    fi

    if [ -f "$tsfile" ]; then
        tsraw="$(sed -n 's/^export const DRIDOCK_TS_VERSION = "\([^"]*\)";$/\1/p' "$tsfile" | head -1)"
    else
        tsraw=""
    fi
    if [ -n "$tsraw" ]; then
        ok "DRIDOCK_TS_VERSION parsed from dridockVersion.ts ($tsraw)"
    else
        bad "could not parse 'export const DRIDOCK_TS_VERSION = \"...\";' from $tsfile — a refactor that renames it must not silently turn this test into a no-op"
        echo "  #103 version sync: $PASS passed, $FAIL failed"
        return 1
    fi

    # The contract itself.
    if [ "$vraw" = "$tsraw" ]; then
        ok "they agree ($vraw)"
    else
        bad "VERSION=$vraw but DRIDOCK_TS_VERSION=$tsraw — bump BOTH (docs/versioning.md 'Release steps'). The image is stamped from VERSION and the binary reports the constant, so divergence makes 'dridock checkversion' report drift that isn't real."
    fi

    # Shape: both must be plain MAJOR.MINOR.PATCH. `git tag -a vX.Y.Z` and the
    # image label are built from these, so a stray 'v' prefix or a -rc suffix
    # would propagate into the tag and the label.
    if printf '%s' "$vraw" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        ok "VERSION is bare MAJOR.MINOR.PATCH (no 'v', no suffix)"
    else
        bad "VERSION='$vraw' is not bare MAJOR.MINOR.PATCH — it becomes the image label and the git tag"
    fi

    # #106: CHANGELOG.md keeps exactly one `## [Unreleased]`, above every
    # release heading. `dridock harness update-cli` writes its entry under it,
    # and a cut that renames it to `## [X.Y.Z]` instead of adding the release
    # heading BELOW it (what 5.13.0 did) leaves nothing to anchor on. update-cli
    # now restores a missing one, but the file should never need that. A second
    # copy is a latent trap: anything anchoring on "the" heading picks one of
    # two (a stray sat at line ~850 from 5.2.0 until #106).
    local cl="$REPO/CHANGELOG.md" n_unrel first_unrel first_rel
    n_unrel="$(grep -cE '^## \[Unreleased\][[:space:]]*$' "$cl" 2>/dev/null || true)"
    if [ "$n_unrel" = 1 ]; then
        ok "CHANGELOG.md has exactly one '## [Unreleased]' heading"
    else
        bad "CHANGELOG.md has ${n_unrel:-0} '## [Unreleased]' headings, want 1 — a release cut keeps it and adds '## [X.Y.Z] - <date>' BELOW it (docs/versioning.md 'Release steps')"
    fi
    first_unrel="$(grep -nE '^## \[Unreleased\][[:space:]]*$' "$cl" 2>/dev/null | head -1 | cut -d: -f1)"
    first_rel="$(grep -nE '^## \[[0-9]' "$cl" 2>/dev/null | head -1 | cut -d: -f1)"
    if [ -n "$first_unrel" ] && [ -n "$first_rel" ] && [ "$first_unrel" -lt "$first_rel" ]; then
        ok "'## [Unreleased]' sits above the first release heading (line $first_unrel < $first_rel)"
    else
        bad "'## [Unreleased]' (line ${first_unrel:-none}) is not above the first release heading (line ${first_rel:-none})"
    fi

    echo "  #103 version sync: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_version_sync)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_version_sync
fi

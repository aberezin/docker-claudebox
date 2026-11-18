#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #155: the deadline test's own noise filter must not silence the test.
#
# WHY: test_deprecation_deadlines excluded its fixtures with
#   grep -v "tests/.tmp\|/logs/\|/roadmap.md\|test_deprecation_deadlines"
# matched against ABSOLUTE paths, because every call site passes "$REPO/...".
# Run from a git worktree under tests/.tmp-* — which is where the daemon suites
# must run from under DooD — every hit contained that ancestor's name and was
# dropped, so `hits` was empty for every row. Empty means opposite things in the
# two branches: a loud FAIL where the deadline is future, and a silent
# `ok "removed, as committed"` where it has passed. 6.1.1's gate hit it and
# reported SIX "removed" passes having read nothing (#151).
#
# That test is the mechanism CLAUDE.md relies on for "a prose deadline does not
# hold; a test that fails the moment the release arrives does" (#82), so it
# failing open is worse than most. This drives the extracted filter directly,
# with a repo root whose own path contains tests/.tmp — the case that was broken.

_DF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_deadline_filter() {
local REPO="$_DF_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- the deadline test's noise filter is anchored to its own repo (#155) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> dd_grep/,/^# <<< dd_grep/p' "$REPO/tests/test_deprecation_deadlines.sh" > "$fn"
if ! grep -q '^_dd_grep()' "$fn"; then
    bad "_dd_grep not found between the markers in tests/test_deprecation_deadlines.sh: the cases below would test nothing"
    rm -rf "$tmp"; echo "  deadline filter: $PASS passed, $FAIL failed"; return 1
fi
# shellcheck disable=SC1090
. "$fn"

local MARK='LEGACY_THING_UNDER_DEADLINE'
# A fake repo whose OWN path contains tests/.tmp — the #155 trap.
local RREAL="$tmp/tests/.tmp-sim"
mkdir -p "$RREAL/tests/.tmp-fixture" "$RREAL/tests/logs" "$RREAL/docs" "$RREAL/tests/Xtmp"
printf '%s\n' "$MARK" > "$RREAL/entrypoint.sh"                      # real code: MUST be reported
printf '%s\n' "$MARK" > "$RREAL/tests/.tmp-fixture/leftover.sh"     # a fixture: must be excluded
printf '%s\n' "$MARK" > "$RREAL/tests/logs/run.log"                 # a per-test log: excluded
printf '%s\n' "$MARK" > "$RREAL/docs/roadmap.md"                    # the roadmap names it by design: excluded
printf '%s\n' "$MARK" > "$RREAL/tests/test_deprecation_deadlines.sh" # the test's own patterns: excluded
printf '%s\n' "$MARK" > "$RREAL/tests/Xtmp/real.sh"                 # NOT a fixture dir: must be reported

local hits
hits=$(_dd_grep -rl "$MARK" "$RREAL")

# 1. The case #155 is about: a repo under tests/.tmp still finds its own code.
printf '%s\n' "$hits" | grep -qF "$RREAL/entrypoint.sh" \
    && ok "a repo whose path contains tests/.tmp still reports its own code (#155)" \
    || bad "the repo's own entrypoint.sh was filtered out because an ANCESTOR is named tests/.tmp — the test asserts nothing from such a worktree"

# 2-5. The exclusions still do their job, relative to THIS repo.
printf '%s\n' "$hits" | grep -qF 'tests/.tmp-fixture' \
    && bad "a fixture under the repo's own tests/.tmp-* leaked into the hits" \
    || ok "the repo's own tests/.tmp-* fixtures are still excluded"
printf '%s\n' "$hits" | grep -qF '/tests/logs/' \
    && bad "a per-test log leaked into the hits" || ok "tests/logs/ is still excluded"
printf '%s\n' "$hits" | grep -qF '/docs/roadmap.md' \
    && bad "docs/roadmap.md leaked into the hits (it names every deadline by design)" \
    || ok "docs/roadmap.md is still excluded"
printf '%s\n' "$hits" | grep -qF 'test_deprecation_deadlines.sh' \
    && bad "the deadline test's own file leaked into the hits" \
    || ok "the deadline test's own file is still excluded"

# 6. -F, not a regex: the old pattern's "." matched any character, so a
#    directory like tests/Xtmp was silently excluded too.
printf '%s\n' "$hits" | grep -qF "$RREAL/tests/Xtmp/real.sh" \
    && ok "tests/Xtmp is NOT excluded: the exclusions are literal, not regexes" \
    || bad "tests/Xtmp was excluded, so 'tests/.tmp' is still being read as a regex"

# 7. A repo path with nothing special in it behaves the same way (control).
local CLEAN="$tmp/plain/repo"
mkdir -p "$CLEAN/tests/.tmp-fixture"
printf '%s\n' "$MARK" > "$CLEAN/entrypoint.sh"
printf '%s\n' "$MARK" > "$CLEAN/tests/.tmp-fixture/leftover.sh"
local chits; RREAL="$CLEAN" chits=$(RREAL="$CLEAN" _dd_grep -rl "$MARK" "$CLEAN")
printf '%s\n' "$chits" | grep -qF "$CLEAN/entrypoint.sh" \
    && ok "control: an ordinary repo path reports its code" || bad "control: an ordinary repo path reported nothing"
printf '%s\n' "$chits" | grep -qF 'tests/.tmp-fixture' \
    && bad "control: the fixture leaked" || ok "control: its fixtures are excluded"

# 8. The unanchored form must not come back — checked against CODE, not prose.
#    The first version of this case grepped the whole file and matched the WHY
#    comment above, which quotes the old pattern on purpose. A matcher that hits
#    its own documentation is the same trap as #132's `*build*`.
grep -vE '^[[:space:]]*#' "$REPO/tests/test_deprecation_deadlines.sh" | grep -qE 'grep -v "tests/\.tmp' \
    && bad "the unanchored substring filter is back in test_deprecation_deadlines.sh (#155)" \
    || ok "no unanchored substring filter remains in the code (the WHY comment still quotes it)"

rm -rf "$tmp"
echo "  deadline filter: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_deadline_filter)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_deadline_filter
fi

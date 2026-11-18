#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #140: every tests/test_*.sh is wired into test.sh — it registers its
# functions in ALL_TESTS, and every name it registers is really defined there.
#
# WHY: test.sh sources tests/test_*.sh and then runs ALL_TESTS by NAME, so a
# file that registers nothing is sourced and never run. `make test` reports
# success without it. tests/test_report_bug.sh sat like that behind a
# `[ "${BASH_SOURCE[0]}" != "${0}" ] && return 0` guard on line 7, passing 10/0
# only for someone who already knew the standalone command — found while
# sweeping for the 6.0.0 gate, not by the suite (Arfy, #137/#140).
#
# This is the shell analogue of tests/test_python_tests_named.sh (#138), and the
# same shape as tests/test_docs_index.sh: a list kept by hand drifts silently.
# The second assertion (a registered name resolves to a function in the same
# file) covers the other half — test.sh aborts on an unknown test name, so a
# typo in ALL_TESTS breaks the whole suite rather than skipping one test.
#
# Pure grep/awk: no image, no docker, no network.

_STR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Deliberate standalones. A file listed here may register nothing; the text
# after the path is the reason, and it has to be a reason that CANNOT be fixed
# by making the body a function (see test_report_bug.sh's header for the four
# that looked inherent and weren't). Empty on purpose: #140 converted the only
# entry rather than grandfathering it.
_STR_STANDALONE_OK=(
    # "tests/test_example.sh — why this one cannot be a suite function"
)

# Echo the function names a file registers, one per line. Handles both forms:
#   ALL_TESTS+=(test_a)
#   ALL_TESTS+=(
#       test_a
#       test_b
#   )
# `ALL_TESTS=()` (the reset in a standalone footer) deliberately does not match.
_str_registered_names() {
    awk '
    BEGIN { inblk = 0 }
    {
        line = $0
        sub(/#.*/, "", line)
        if (inblk == 0) {
            if (line ~ /ALL_TESTS\+=\(/) { sub(/.*ALL_TESTS\+=\(/, "", line); inblk = 1 }
            else next
        }
        if (line ~ /\)/) { sub(/\).*/, "", line); inblk = 0 }
        print line
    }' "$1" | tr -s ' \t' '\n\n' | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' || true  # swallow-ok: grep returns 1 for a file that registers nothing, which the caller reports
}

test_shell_tests_registered() {
local REPO="$_STR_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- every shell test is wired into test.sh (#140) ---"

local f base n=0 names count allowed e nm miss
for f in "$REPO"/tests/test_*.sh; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    base="tests/$(basename "$f")"

    allowed=0
    if [ "${#_STR_STANDALONE_OK[@]}" -gt 0 ]; then
        for e in "${_STR_STANDALONE_OK[@]}"; do
            case "$e" in "$base"*) allowed=1 ;; esac
        done
    fi

    names="$(_str_registered_names "$f")"

    if [ -z "$names" ]; then
        if [ "$allowed" = 1 ]; then
            ok "$base is a documented standalone"
        else
            bad "$base registers nothing in ALL_TESTS, so test.sh sources it and never runs it (add ALL_TESTS+=(…), or list it in _STR_STANDALONE_OK with a reason that isn't fixable)"
        fi
        continue
    fi

    if [ "$allowed" = 1 ]; then
        bad "$base is listed in _STR_STANDALONE_OK but does register: drop it from that list"
    fi

    miss=0
    while IFS= read -r nm; do
        [ -n "$nm" ] || continue
        grep -qE "^[[:space:]]*(function[[:space:]]+)?${nm}[[:space:]]*\(\)" "$f" \
            || { bad "$base registers '$nm' but defines no such function — test.sh aborts on an unknown test name, taking the whole suite with it"; miss=1; }
    done <<< "$names"

    count="$(printf '%s\n' "$names" | grep -c .)"
    [ "$miss" = 0 ] && ok "$base registers $count function(s), all defined"
done

# A glob that matched nothing would pass everything.
[ "$n" -gt 0 ] && ok "found $n shell test file(s)" || bad "no tests/test_*.sh found: the check would pass vacuously"

echo "  shell tests registered: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_shell_tests_registered)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_shell_tests_registered
fi

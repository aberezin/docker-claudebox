#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #138: every tests/test_*.py is named in CLAUDE.md's Python-test section.
#
# WHY: test.sh runs only the bash suite, so a Python test is run by a person
# who reads CLAUDE.md for the command, or by nobody. tests/test_cron_drift.py
# shipped named nowhere (Arfy, #138 review), the same shape as the unindexed
# docs test_docs_index.sh exists for: a list kept by hand drifts silently.
# Pure grep: no image, no python deps.

_PTN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_python_tests_named() {
local REPO="$_PTN_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- every Python test is named in CLAUDE.md (#138) ---"

local f n=0
for f in "$REPO"/tests/test_*.py; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    f="tests/$(basename "$f")"
    grep -qF "$f" "$REPO/CLAUDE.md" && ok "$f is named in CLAUDE.md" \
        || bad "$f is named nowhere in CLAUDE.md, so nothing runs it (add it to the Python-test commands)"
done
# A glob that matched nothing would pass everything.
[ "$n" -gt 0 ] && ok "found $n Python test file(s)" || bad "no tests/test_*.py found: the check would pass vacuously"

echo "  python tests named: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_python_tests_named)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_python_tests_named
fi

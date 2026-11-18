#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #144: test.sh counts a test as failed when it prints a FAIL line, whichever
# form the file uses.
#
# WHY: test.sh's backstop exists because a shell function returns the status of
# its LAST command, so a trailing `rm -rf "$tmpdir"` masks a failed assertion
# above it and a visibly-failing test is counted as PASSED (#63). The comment
# on it says it "keeps working for tests written later, rather than depending
# on every author remembering `|| return 1`" — but it greped `FAIL:` with a
# colon, and 28 of 35 test files print `  FAIL $1` without one. So the backstop
# covered 7 files and every other author was back to remembering (Arfy, #144).
#
# A change to a failure DETECTOR cannot be verified by "the suite still
# passes": that exercises only the pass path. This runs the real _test_outcome,
# extracted from test.sh between its markers, over synthetic logs — including
# the ones that must NOT count as failures.

_RFD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_runner_failure_detection() {
local REPO="$_RFD_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- test.sh: the FAIL backstop catches every reporter form (#144) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> test_outcome/,/^# <<< test_outcome/p' "$REPO/test.sh" > "$fn"
if ! grep -q '^_test_outcome()' "$fn"; then
    bad "_test_outcome not found between the markers in test.sh: the cases below would test nothing"
    rm -rf "$tmp"; echo "  runner failure detection: $PASS passed, $FAIL failed"; return 1
fi
# shellcheck disable=SC1090
. "$fn"

# verdict <expected> <rc> <log line…>
local n=0
verdict() {
    local want="$1" rc="$2"; shift 2
    local log="$tmp/log.$((n++))"
    printf '%s\n' "$@" > "$log"
    local got; got="$(_test_outcome "$rc" "$log")"
    [ "$got" = "$want" ] && ok "$want: rc=$rc, log: $*" \
        || bad "expected $want, got $got — rc=$rc, log: $*"
}

# ── the pass path ────────────────────────────────────────────────────────────
verdict pass 0 "  ok   everything fine" "  thing: 3 passed, 0 failed"

# ── rc alone still fails a test ──────────────────────────────────────────────
verdict fail 1 "  ok   everything fine"

# ── the colon form, which already worked (common.sh's assert_*) ──────────────
verdict fail 0 "  FAIL: name: expected 'a', got 'b'"

# ── the form 28 of 35 files use, and the whole point of #144 ────────────────
verdict fail 0 "  FAIL no report file"
verdict fail 0 "	FAIL tab-indented reporter"
verdict fail 0 "FAIL unindented reporter"

# ── and it fails even when the function returned 0: the #63 masking case ────
verdict fail 0 "  ok   first assertion" "  FAIL second assertion" "  thing: 1 passed, 1 failed"

# ── things that must NOT count as failures ───────────────────────────────────
# The ^ anchor: a test may print the word mid-line while passing.
verdict pass 0 "  ok   expected FAIL for a bad input"
verdict pass 0 "  ok   self-test: flags  x || true"
# FAILED is narration, not a reporter: the char after FAIL must be : or space.
verdict pass 0 "  FAILED to reach the host, retrying"
verdict pass 0 "  ok   0 FAILures"
# An empty log from a test that returned 0 is a pass, not a false alarm.
: > "$tmp/empty"
[ "$(_test_outcome 0 "$tmp/empty")" = pass ] && ok "pass: rc=0 with an empty log" \
    || bad "empty log counted as a failure"

# ── the regression this replaces: the old pattern missed the common form ────
grep -qE '\^\[\[:space:\]\]\*FAIL\[: \]' "$REPO/test.sh" \
    && ok "test.sh greps FAIL[: ], so every reporter form is covered" \
    || bad "test.sh no longer greps FAIL[: ]: the backstop is back to covering only the colon form"

rm -rf "$tmp"
echo "  runner failure detection: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_runner_failure_detection)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_runner_failure_detection
fi

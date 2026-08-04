#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/tests/common.sh"

# shellcheck disable=SC1090
for f in "$SCRIPT_DIR"/tests/test_*.sh; do
    source "$f"
done

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
    exit 0
fi

TESTS_TO_RUN=("${@}")
if [ ${#TESTS_TO_RUN[@]} -eq 0 ]; then
    TESTS_TO_RUN=("${ALL_TESTS[@]}")
fi

for t in "${TESTS_TO_RUN[@]}"; do
    if ! declare -f "$t" >/dev/null 2>&1; then
        echo "unknown test: $t"
        echo ""
        usage
        exit 1
    fi
done

trap cleanup EXIT
setup

# Per-test logs: stdout+stderr of every test goes to tests/logs/<testname>.log
# (overwritten each run). The new e2e tests also dump container logs into this
# dir so a failure has all the evidence in one place.
export TEST_LOG_DIR="$SCRIPT_DIR/tests/logs"
mkdir -p "$TEST_LOG_DIR"

echo ""
echo "=== running ${#TESTS_TO_RUN[@]} test(s) ==="
echo "    per-test logs: $TEST_LOG_DIR/<testname>.log"
echo ""

FAILED=0
PASSED=0

for t in "${TESTS_TO_RUN[@]}"; do
    echo "--- $t ---"
    test_setup
    log_file="$TEST_LOG_DIR/$t.log"
    : > "$log_file"   # truncate for this run
    # Run the test, tee its output into the per-test log, recover the test's
    # own exit code (not tee's) via PIPESTATUS. The `if` form exempts the
    # pipeline from `set -e` so a failing test doesn't kill the runner.
    if $t 2>&1 | tee "$log_file"; then
        rc_first=0
    else
        rc_first=${PIPESTATUS[0]}
    fi
    # A test passes only if it BOTH returned 0 AND printed no FAIL line.
    #
    # Return code alone is not sufficient: a shell function exits with the status
    # of its LAST command, so a trailing cleanup line masks a failed assertion
    # above it —
    #
    #     assert_eq "$owner" "$host_uid" "..."   # prints FAIL, returns 1
    #     rm -rf "$tmpdir"                       # returns 0  <- function returns 0
    #
    # the runner then counts a visibly-failing test as PASSED. Bear caught this on
    # #63 (test_entrypoint_workspace_ownership, docker backend). At least 11 tests
    # end with cleanup after their last assert, so this was never one test's bug.
    #
    # Checking the log closes the whole class at once and keeps working for tests
    # written later, rather than depending on every author remembering
    # `|| return 1`. It is also the same rule this suite is being fixed to
    # enforce elsewhere: a failure must not be silently discarded.
    if [ "$rc_first" -ne 0 ] || grep -qE "^[[:space:]]*FAIL:" "$log_file"; then
        FAILED=$((FAILED + 1))
        [ "$rc_first" -eq 0 ] && echo "  ^^ counted FAILED: assertion failed but the test function returned 0"
    else
        PASSED=$((PASSED + 1))
    fi
    test_teardown
done

echo ""
echo "=== results: $PASSED passed, $FAILED failed ==="

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi

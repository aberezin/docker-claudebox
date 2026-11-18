#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# Unit tests for the cb-report-bug helper (pure — no docker/colima).
#
# Run:  bash test.sh test_report_bug        (part of the suite)
#   or: bash tests/test_report_bug.sh       (standalone, unchanged)
#
# #140: this file used to opt OUT of the suite. Line 7 was
#   [ "${BASH_SOURCE[0]}" != "${0}" ] && return 0
# so `make test` never ran it and it passed only for someone who already knew
# to run it by hand (Arfy found it sweeping for the 6.0.0 gate, #137).
#
# WHY it opted out, and what had to change: it was written as a top-level
# SCRIPT, not a test function. Sourced by test.sh's glob it would have (a) run
# every assertion at source time, before the runner had chosen which tests to
# run, (b) set `-uo pipefail` on the whole suite's shell, (c) armed a
# `trap … EXIT` that fires when the SUITE ends, not when this test does, and
# (d) defined PASS/FAIL/ok/bad at global scope for every later test to inherit.
# The guard was a reasonable response to all four. None of them is inherent:
# the body is now a function with locals, cleanup runs before the final status,
# and the dual-mode footer keeps the standalone command working. See
# tests/test_shell_tests_registered.sh for the gate that stops the next one.
#
# Two conventions this file follows deliberately:
#   * Failures print "FAIL:" WITH the colon — that is the form test.sh's
#     log-based backstop greps for (test.sh ~line 81), so a trailing cleanup
#     line can never mask a failed assertion here.
#   * An invocation's rc is captured, never discarded with `|| true`. Where the
#     rc is not itself the assertion (the writer may legitimately return
#     non-zero while still producing the fallback file), it is carried into the
#     failure message so a red test says what the helper actually did.

_RB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_report_bug() {
local RB="$_RB_DIR/../cb-report-bug"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- cb-report-bug (#140) ---"

if [ ! -f "$RB" ]; then
    bad "cb-report-bug not found at $RB"
    echo "  report-bug: $PASS passed, $FAIL failed"
    return 1
fi

local TMP f g ws rc
TMP="$(mktemp -d)"

# ── report from stdin lands in the shared dir with metadata + body ───────────
rc=0
DRIDOCK_FRAMEWORK_BUGS_DIR="$TMP/fwb" DRIDOCK_PROJECT_ID=proj9 CLAUDE_IMAGE_VARIANT=minimal \
    bash "$RB" "mount empty under tmp" --layer wrapper <<'REPORT' >/dev/null 2>&1 || rc=$?
## What I was doing
started claudebot
REPORT
[ "$rc" -eq 0 ] && ok "writes a report from stdin (rc 0)" || bad "writing a report from stdin returned rc $rc"
f="$(ls "$TMP/fwb"/proj9-*.md 2>/dev/null | head -1)"
[ -n "$f" ] && ok "writes a report file to the shared dir" || bad "no report file"
grep -q '^# mount empty under tmp' "$f" 2>/dev/null && ok "title heading" || bad "no title heading"
grep -q 'layer:.*wrapper' "$f" 2>/dev/null && ok "layer metadata" || bad "no layer metadata"
grep -q 'project id:.*proj9' "$f" 2>/dev/null && ok "project id metadata" || bad "no project id metadata"
grep -q 'image variant:.*minimal' "$f" 2>/dev/null && ok "image variant metadata" || bad "no image variant"
grep -q '## What I was doing' "$f" 2>/dev/null && ok "body captured" || bad "body missing"
# filename carries a slug of the title
case "$(basename "${f:-}")" in *mount-empty-under-tmp*) ok "filename slug" ;; *) bad "no slug in filename" ;; esac

# ── --body-file works ────────────────────────────────────────────────────────
printf '## Repro\nsteps\n' > "$TMP/body.md"
rc=0
DRIDOCK_FRAMEWORK_BUGS_DIR="$TMP/fwb2" DRIDOCK_PROJECT_ID=p2 \
    bash "$RB" "second bug" --body-file "$TMP/body.md" >/dev/null 2>&1 || rc=$?
g="$(ls "$TMP/fwb2"/p2-*.md 2>/dev/null | head -1)"
{ [ -n "$g" ] && grep -q '## Repro' "$g"; } && ok "--body-file captured" \
    || bad "--body-file failed (writer rc $rc)"

# ── falls back to a workspace file when the shared dir is unwritable ──────────
# The rc here is not the assertion: the helper is expected to report the shared
# dir as unusable AND still leave the report in the workspace. The file is the
# contract; the rc is carried into the message for a red run.
ws="$TMP/ws"; mkdir -p "$ws"
rc=0
( cd "$ws" && DRIDOCK_FRAMEWORK_BUGS_DIR="/cannot-create-$RANDOM/x" \
    bash "$RB" "fallback case" <<<'## x' >/dev/null 2>&1 ) || rc=$?
[ -f "$ws/.dridock/FRAMEWORK-BUGS.md" ] && ok "falls back to workspace FRAMEWORK-BUGS.md" \
    || bad "no fallback file (writer rc $rc)"

# ── requires a title ─────────────────────────────────────────────────────────
if DRIDOCK_FRAMEWORK_BUGS_DIR="$TMP/fwb3" bash "$RB" <<<'' >/dev/null 2>&1; then
    bad "missing title should fail"
else
    ok "requires a title (usage error)"
fi

# Cleanup BEFORE the status line: a trailing `rm -rf` returns 0 and would mask
# every failure above it (test.sh ~line 66 documents that class).
rm -rf "$TMP"

echo "  report-bug: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_report_bug)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_report_bug
fi

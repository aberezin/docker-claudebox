#!/usr/bin/env bash
# Standalone unit tests for the cb-report-bug helper (pure — no docker/colima).
#
# Run:  bash tests/test_report_bug.sh
#
# Standalone runner: if sourced by test.sh's glob, do nothing.
[ "${BASH_SOURCE[0]}" != "${0}" ] && return 0 2>/dev/null

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RB="$SCRIPT_DIR/../cb-report-bug"

PASS=0
FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── report from stdin lands in the shared dir with metadata + body ───────────
CLAUDEBOX_FRAMEWORK_BUGS_DIR="$TMP/fwb" CLAUDEBOX_PROJECT_ID=proj9 CLAUDE_IMAGE_VARIANT=minimal \
    bash "$RB" "mount empty under tmp" --layer wrapper <<'EOF' >/dev/null 2>&1
## What I was doing
started claudebot
EOF
f="$(ls "$TMP/fwb"/proj9-*.md 2>/dev/null | head -1)"
[ -n "$f" ]                                   && ok "writes a report file to the shared dir" || bad "no report file"
grep -q '^# mount empty under tmp' "$f" 2>/dev/null && ok "title heading"        || bad "no title heading"
grep -q 'layer:.*wrapper'  "$f" 2>/dev/null   && ok "layer metadata"             || bad "no layer metadata"
grep -q 'project id:.*proj9' "$f" 2>/dev/null && ok "project id metadata"        || bad "no project id metadata"
grep -q 'image variant:.*minimal' "$f" 2>/dev/null && ok "image variant metadata" || bad "no image variant"
grep -q '## What I was doing' "$f" 2>/dev/null && ok "body captured"             || bad "body missing"
# filename carries a slug of the title
case "$(basename "$f")" in *mount-empty-under-tmp*) ok "filename slug" ;; *) bad "no slug in filename" ;; esac

# ── --body-file works ────────────────────────────────────────────────────────
printf '## Repro\nsteps\n' > "$TMP/body.md"
CLAUDEBOX_FRAMEWORK_BUGS_DIR="$TMP/fwb2" CLAUDEBOX_PROJECT_ID=p2 \
    bash "$RB" "second bug" --body-file "$TMP/body.md" >/dev/null 2>&1
g="$(ls "$TMP/fwb2"/p2-*.md 2>/dev/null | head -1)"
{ [ -n "$g" ] && grep -q '## Repro' "$g"; } && ok "--body-file captured" || bad "--body-file failed"

# ── falls back to a workspace file when the shared dir is unwritable ──────────
ws="$TMP/ws"; mkdir -p "$ws"
( cd "$ws" && CLAUDEBOX_FRAMEWORK_BUGS_DIR="/cannot-create-$RANDOM/x" \
    bash "$RB" "fallback case" <<<'## x' >/dev/null 2>&1 )
[ -f "$ws/.dridock/FRAMEWORK-BUGS.md" ] && ok "falls back to workspace FRAMEWORK-BUGS.md" || bad "no fallback file"

# ── requires a title ─────────────────────────────────────────────────────────
if CLAUDEBOX_FRAMEWORK_BUGS_DIR="$TMP/fwb3" bash "$RB" <<<'' >/dev/null 2>&1; then
    bad "missing title should fail"
else
    ok "requires a title (usage error)"
fi

echo ""
echo "report-bug: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

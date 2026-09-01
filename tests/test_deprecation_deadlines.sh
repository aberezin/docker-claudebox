#!/usr/bin/env bash
# Enforcement for the commitments in docs/roadmap.md.
#
# WHY THIS EXISTS: entrypoint.sh told every claudebot that legacy CLAUDEBOX_*
# names would "go away in 4.0". We shipped 4.0, 4.1, 4.2, 4.3 and 4.4 with the
# aliaser still live and the promise still printed. Nobody noticed until a
# namespace sweep (#82). Prose deadlines do not hold; a failing test does.
#
# Each commitment is checked in BOTH directions:
#   - deadline reached  -> the thing MUST be gone
#   - deadline future   -> the thing MUST still be here
# The second direction matters as much as the first: without it a row can rot
# into a stale entry describing code that was already deleted, and the file
# stops describing reality.
#
# Self-registers into ALL_TESTS so `bash test.sh` actually runs it. The old
# env-rename compat test used the standalone `return 0 when sourced` shape,
# which meant test.sh sourced it and ran NOTHING — a lint nobody was running.
# Also directly runnable: `bash tests/test_deprecation_deadlines.sh`.
_DD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_deprecation_deadlines() {
local REPO="$_DD_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

local MAJOR
MAJOR="$(cut -d. -f1 < "$REPO/VERSION")"
echo "--- deprecation deadlines (current major: $MAJOR) ---"

# deadline <label> <deadline-major> <grep-args...>
#   Asserts the pattern is ABSENT once $MAJOR >= deadline, PRESENT before it.
deadline() {
    local label="$1" due="$2"; shift 2
    local hits
    hits=$(grep -rl "$@" 2>/dev/null | grep -v "tests/.tmp\|/logs/\|/roadmap.md\|test_deprecation_deadlines" | head -5)
    if [ "$MAJOR" -ge "$due" ]; then
        if [ -z "$hits" ]; then
            ok "$label — removed, as committed for ${due}.0.0"
        else
            bad "$label — ${due}.0.0 committed its removal in docs/roadmap.md, but it is STILL PRESENT:"
            printf '         %s\n' $hits >&2
        fi
    else
        if [ -n "$hits" ]; then
            ok "$label — still present (due ${due}.0.0, not yet reached)"
        else
            bad "$label — already gone, but docs/roadmap.md still promises it for ${due}.0.0 (stale row — update the roadmap)"
        fi
    fi
}

# ── 5.0.0: legacy env tiers + the container aliaser ────────────────────────
# Match a READ, not a mention. Tests must still NAME the legacy variable in
# order to assert it is ignored (`{ CLAUDEBOX_X: "v" }` as input, expecting no
# effect), and comments describe the removal. Grepping the bare name would flag
# all of that and the check would be permanently red — i.e. useless.
# A read is language-specific syntax:
#   shell   ${CLAUDEBOX_X…             python  environ.get("CLAUDEBOX_X"…
#   ts      env["CLAUDEBOX_X"]  /  env[`CLAUDEBOX_${…}`]
# Note the TS pattern requires the opening BRACKET: prose in a JSDoc block
# writes `CLAUDEBOX_X` in markdown backticks, and matching a bare backtick
# flagged this file's own explanation of the removal.
deadline "legacy CLAUDEBOX_* env READS (shell)" 5 \
    --include=*.sh -e '\${CLAUDEBOX_[A-Z_]' "$REPO/entrypoint.sh" "$REPO/install.sh" "$REPO/.claude/hooks"
deadline "legacy CLAUDEBOX_* env READS (python)" 5 \
    -e 'environ\.get("CLAUDEBOX_\|environ\["CLAUDEBOX_' "$REPO"/*.py
deadline "legacy CLAUDEBOX_* env READS (typescript)" 5 \
    --include=*.ts -e '\["CLAUDEBOX_\|\[`CLAUDEBOX_' "$REPO/dridock-ts/src"
deadline "container env aliaser (_dridock_alias_env)" 5 \
    -e '_dridock_alias_env' "$REPO/entrypoint.sh"

# ── 6.0.0: the .claudebox -> .dridock migration path ───────────────────────
# Kept through 5.x deliberately: 5.0 makes a legacy dot-dir a LOUD error that
# names `dridock migrate`, so the migrators are what that error points at.
# Removing both at once would delete the bridge and the destination together.
deadline "migrate verb + migrators" 6 \
    --include=*.ts -e 'autoMigrateIfNeeded\|class .*Migrator' "$REPO/dridock-ts/src"

echo ""
echo "  deprecation deadlines: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_deprecation_deadlines)

# Direct invocation (not sourced by test.sh) → run it now.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_deprecation_deadlines
fi

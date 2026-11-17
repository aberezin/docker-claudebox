#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #128: a refused `--continue` is no longer silently replaced by a fresh session.
#
# WHY: entrypoint.sh ran `claude --continue … || exec claude …`. On 2026-11-16 a
# recreated container's `--continue` was REFUSED ("moved to a background session
# … registered from another machine or container"), and the fallback started a
# fresh session whose TUI cleared the refusal off the screen, so a 99 MB
# conversation looked lost. With nothing to continue, `--continue` exits 0
# (CLI 2.1.319 and 2.1.326), so the fallback only ever hid real failures.
#
# Takes the interactive command string straight out of entrypoint.sh and runs it
# under `bash -c` with a stub `claude`, so it needs no image and no API.

_CNF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_continue_no_fallback() {
local REPO="$_CNF_DIR/.."
local EP="$REPO/entrypoint.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- entrypoint: no silent fresh-session fallback for --continue (#128) ---"

# 1. Structural: no `|| exec claude` anywhere (both launch paths had one).
# Code only: the comments explaining the removal quote the old shape.
local hits; hits="$(grep -n '|| exec claude' "$EP" | grep -vE '^[0-9]+:[[:space:]]*#')"
if [ -n "$hits" ]; then
    bad "entrypoint.sh still has a '|| exec claude' fallback: $(printf '%s' "$hits" | head -2 | tr '\n' ' ')"
else
    ok "no '|| exec claude' fallback left in entrypoint.sh"
fi

# 2. Behaviour of the interactive command, with a stub claude that records each
#    invocation and exits with $STUB_RC.
# The $CMD below is literal text to find, not an expansion.
local line
# shellcheck disable=SC2016
line="$(grep -n 'CMD="\$CMD && { claude --dangerously-skip-permissions --continue' "$EP" | head -1 | cut -d: -f1)"
if [ -z "$line" ]; then
    bad "couldn't find the interactive --continue command in entrypoint.sh: the cases below would test nothing"
    echo "  continue no-fallback: $PASS passed, $FAIL failed"; return 1
fi
local tmp; tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
echo "claude $*" >> "$STUB_LOG"
exit "${STUB_RC:-0}"
STUB
chmod 755 "$tmp/bin/claude"
local assign; assign="$(sed -n "${line}p" "$EP" | sed 's/^[[:space:]]*//')"
build() {
    # Read by the eval'd assignment below.
    # shellcheck disable=SC2034
    local CMD="true" SYSTEM_HINT_FLAG="" INTERACTIVE_EXTRA="'--remote-control'"
    eval "$assign"
    printf '%s' "$CMD"
}
local cmd; cmd="$(build)"
runit() {   # $1 = rc the stub returns; sets out, rc, calls
    : > "$tmp/log"
    out="$(STUB_RC="$1" STUB_LOG="$tmp/log" PATH="$tmp/bin:$PATH" bash -c "$cmd" 2>&1)"; rc=$?
    calls="$(wc -l < "$tmp/log" | tr -d ' ')"
}
local out rc calls

runit 0
[ "$rc" -eq 0 ] && [ "$calls" -eq 1 ] && [ -z "$out" ] && grep -q -- '--continue' "$tmp/log" \
    && ok "rc 0 (normal exit, or nothing to continue): one run, with --continue, nothing printed" \
    || bad "rc 0 case: rc=$rc calls=$calls out=$out"

runit 1
if [ "$rc" -eq 1 ] && [ "$calls" -eq 1 ] && [[ "$out" == *"dridock start --resume <session-id>"* ]]; then
    ok "refused (rc 1): NOT followed by a fresh run, rc kept, and the way back is printed"
else
    bad "refusal case: rc=$rc calls=$calls out=$out"
fi

runit 130
[ "$rc" -eq 130 ] && [ "$calls" -eq 1 ] && [ -z "$out" ] \
    && ok "Ctrl-C (rc 130): exit kept, no misleading hint" || bad "rc 130 case: rc=$rc calls=$calls out=$out"

# 3. `dridock start --resume <id>` must not also get --continue. Use the real
#    condition from entrypoint.sh.
local cond; cond="$(grep -o 'grep -qE "(^|\[ '"'"'\])--resume(\[='"'"' \]|\\\$)"' "$EP" | head -1)"
if [ -z "$cond" ]; then
    bad "couldn't find the --resume detection in entrypoint.sh"
else
    local pat; pat="$(printf '%s' "$cond" | sed -e 's/^grep -qE "//' -e 's/"$//' -e 's/\\\$/$/')"
    m() { printf '%s' "$1" | grep -qE "$pat"; }
    m "'--resume' 'abc'" && m "'--resume=abc'" && m "'--remote-control' '--resume' 'x'" \
        && ok "--resume (separate or =value, anywhere in the args) skips --continue" \
        || bad "--resume not detected (pattern: $pat)"
    ! m "'--remote-control'" && ! m "'--resumex'" \
        && ok "--remote-control / --resumex don't count as --resume" \
        || bad "false --resume match (pattern: $pat)"
fi

rm -rf "$tmp"
echo "  continue no-fallback: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_continue_no_fallback)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_continue_no_fallback
fi

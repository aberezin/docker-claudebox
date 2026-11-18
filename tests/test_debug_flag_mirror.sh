#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #130: DRIDOCK_DEBUG means the same thing to every reader.
#
# WHY: until 6.1 the debug switch was bare DEBUG, read by four parsers with three
# rules. DEBUG=1 turned on api_server.py's logging but not the entrypoint's or
# cron's; DEBUG=TRUE was dropped by the host before anything could disagree.
# Now there's one rule, written in four languages' worth of places (the TS host,
# entrypoint.sh, cron.py, api_server.py). This runs one table through all of
# them and fails on any disagreement, so the copies can't drift apart again.
#
# Each implementation is taken from its own source: the shell functions and the
# Python helper are extracted (importing cron.py would pull yaml/croniter), and
# the TS module is imported by absolute path from a temp file. A missing bun is
# a loud SKIP of that column, never a silent pass.

_DFM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_debug_flag_mirror() {
local REPO="$_DFM_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- DRIDOCK_DEBUG: one rule in every reader (#130) ---"

# DRIDOCK_DEBUG|DEBUG|expected (1 = on). "-" means unset.
local -a cases=(
    "1|-|1" "true|-|1" "TRUE|-|1" "Yes|-|1" "on|-|1" " true |-|1"
    "0|-|0" "false|-|0" "no|-|0" "OFF|-|0" "verbose|-|0" "2|-|0"
    "-|true|1" "-|1|1" "-|TRUE|1" "-|yes|1" "-|false|0" "-|express:*|0" "-|-|0"
    "1|false|1" "0|true|0" "verbose|true|0"
    "t rue|-|0" "o n|-|0" "-|y es|0" "	on	|-|1"
)
local tmp; tmp="$(mktemp -d)"

# Shell: the two functions from entrypoint.sh.
awk '/^_debug_value\(\) \{/,/^\}/; /^_dridock_debug_decide\(\) \{/,/^\}/' "$REPO/entrypoint.sh" > "$tmp/sh.sh"
# Python: _debug_on() from each daemon (to the first blank line after it).
local py
for py in cron api_server; do
    awk '/^def _debug_on\(\)/{f=1} f{print} f && /^$/ && ++n==2 {exit}' "$REPO/$py.py" > "$tmp/$py.py"
done
if ! grep -q '_dridock_debug_decide()' "$tmp/sh.sh" || ! grep -q 'def _debug_on' "$tmp/cron.py" || ! grep -q 'def _debug_on' "$tmp/api_server.py"; then
    bad "couldn't extract the debug rule from entrypoint.sh / cron.py / api_server.py: the comparison would test nothing"
    rm -rf "$tmp"; echo "  debug flag mirror: $PASS passed, $FAIL failed"; return 1
fi
printf 'import { resolveDebug } from "%s/dridock-ts/src/domain/DebugFlag.ts";\nconst e: Record<string, string> = {};\nconst [d, l] = [Bun.argv[2], Bun.argv[3]];\nif (d !== "-") e["DRIDOCK_DEBUG"] = d!;\nif (l !== "-") e["DEBUG"] = l!;\nconsole.log(resolveDebug(e).on ? 1 : 0);\n' "$REPO" > "$tmp/ts.ts"
local bun=""; bun="$(command -v bun || { [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun"; })"
[ -n "$bun" ] || echo "  SKIP: the TypeScript column (no bun on this host); shell and both Python readers are still compared"

local c d l want got_sh got_cron got_api got_ts mism=0
for c in "${cases[@]}"; do
    IFS='|' read -r d l want <<< "$c"
    local -a envargs=()
    [ "$d" != "-" ] && envargs+=("DRIDOCK_DEBUG=$d")
    [ "$l" != "-" ] && envargs+=("DEBUG=$l")
    got_sh=$(env -u DRIDOCK_DEBUG -u DEBUG "${envargs[@]}" bash -c ". '$tmp/sh.sh'; _dridock_debug_decide \"\${DRIDOCK_DEBUG:-}\" \"\${DEBUG:-}\"" 2>/dev/null)
    got_cron=$(env -u DRIDOCK_DEBUG -u DEBUG "${envargs[@]}" python3 -c "import os; exec(open('$tmp/cron.py').read()); print(1 if _debug_on() else 0)")
    got_api=$(env -u DRIDOCK_DEBUG -u DEBUG "${envargs[@]}" python3 -c "import os; exec(open('$tmp/api_server.py').read()); print(1 if _debug_on() else 0)")
    got_ts="$want"
    [ -n "$bun" ] && got_ts=$("$bun" "$tmp/ts.ts" "$d" "$l" 2>&1)
    if [ "$got_sh$got_cron$got_api$got_ts" != "$want$want$want$want" ]; then
        bad "DRIDOCK_DEBUG=[$d] DEBUG=[$l]: want $want, got shell=$got_sh cron=$got_cron api=$got_api ts=$got_ts"
        mism=1
    fi
done
[ "$mism" = 0 ] && ok "all ${#cases[@]} cases agree across entrypoint.sh, cron.py, api_server.py${bun:+ and DebugFlag.ts}"

# The notes: an unrecognised DRIDOCK_DEBUG and a legacy DEBUG are SAID.
local notes
notes=$(bash -c ". '$tmp/sh.sh'; _dridock_debug_decide verbose '' >/dev/null" 2>&1)
[[ "$notes" == *"DRIDOCK_DEBUG=verbose isn't a recognised value"* ]] && ok "entrypoint: unrecognised DRIDOCK_DEBUG is said" || bad "unrecognised value silent: $notes"
notes=$(bash -c ". '$tmp/sh.sh'; _dridock_debug_decide '' 1 >/dev/null" 2>&1)
[[ "$notes" == *"bare DEBUG stops working in 7.0.0"* ]] && ok "entrypoint: legacy DEBUG gets the rename nudge" || bad "legacy nudge missing: $notes"
notes=$(bash -c ". '$tmp/sh.sh'; _dridock_debug_decide '' 'express:*' >/dev/null" 2>&1)
[ -z "$notes" ] && ok "entrypoint: someone else's DEBUG (express:*) is left alone, nothing said" || bad "foreign DEBUG commented on: $notes"

rm -rf "$tmp"
echo "  debug flag mirror: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_debug_flag_mirror)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_debug_flag_mirror
fi

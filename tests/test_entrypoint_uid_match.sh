#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# The stubs are read by the extracted function, which shellcheck can't see.
# shellcheck disable=SC2015,SC2034
# #141: the entrypoint's uid matching says what it did.
#
# WHY: a container lifetime read the workspace as 501, so claude became 501 and
# $HOME was chowned to it; the next read 1000, and the 501-owned named volumes
# were unwritable. None of it was visible: the skip was silent, the chown's rc
# went nowhere, and the change between starts wasn't noticed.
#
# Takes _match_claude_uid straight out of entrypoint.sh and runs it with stub
# functions for stat/id/usermod/groupmod/find/xargs/chown, so it needs no root,
# no image and no daemon.

_EUM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_entrypoint_uid_match() {
local REPO="$_EUM_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- entrypoint: uid matching is observable (#141) ---"

local tmp; tmp="$(mktemp -d)"
awk '/^_match_claude_uid\(\) \{/,/^\}/' "$REPO/entrypoint.sh" > "$tmp/fn.sh"
if ! grep -q '_match_claude_uid()' "$tmp/fn.sh"; then
    bad "couldn't extract _match_claude_uid from entrypoint.sh: the cases below would test nothing"
    rm -rf "$tmp"; echo "  entrypoint uid match: $PASS passed, $FAIL failed"; return 1
fi

# One run in a subshell. Inputs: WS_UID WS_GID C_UID C_GID XARGS_RC CHOWN_RC.
# Prints stderr, then a line "CALLS: …" and "CLAUDE: uid:gid".
run() {
    (
        WS_UID="$1" WS_GID="$2" C_UID="$3" C_GID="$4" XARGS_RC="${5:-0}" CHOWN_RC="${6:-0}"
        RECORD="$7"
        CALLS=""
        dbg() { :; }
        stat() { case "$2" in %u) echo "$WS_UID" ;; %g) echo "$WS_GID" ;; esac; }
        id() { case "$1" in -u) echo "$C_UID" ;; -g) echo "$C_GID" ;; esac; }
        usermod() { CALLS+=" usermod:$2"; C_UID="$2"; }
        groupmod() { CALLS+=" groupmod:$2"; C_GID="$2"; }
        nproc() { echo 4; }
        find() { CALLS+=" find"; }
        xargs() { CALLS+=" xargs"; return "$XARGS_RC"; }
        chown() { return "$CHOWN_RC"; }
        # shellcheck disable=SC1091
        . "$tmp/fn.sh"
        _match_claude_uid "$tmp/ws" "$RECORD" 2>&1
        echo "CALLS:$CALLS"
        echo "CLAUDE: $C_UID:$C_GID"
    )
}
mkdir -p "$tmp/ws" "$tmp/claude"
local out R="$tmp/claude/.dridock-claude-uid"

# 1. colima's designed case: the workspace reads as root → skipped, and said.
out="$(run 0 0 1000 1000 0 0 "$R")"
[[ "$out" == *"workspace reads 0:0, claude runs as 1000:1000 (skipped: the workspace reads as root"* ]] \
    && [[ "$out" != *usermod* && "$out" != *groupmod* && "$out" != *find* ]] && [ "$(cat "$R")" = "1000:1000" ] \
    && ok "workspace reads as root → skip is SAID, nothing remapped, 1000:1000 recorded" \
    || bad "root case: $out / record=$(cat "$R" 2>/dev/null)"
[[ "$out" != *"CHANGED"* ]] && ok "first record → no change warning" || bad "change warned with no prior record: $out"

# 2. Same again: record matches → no warning.
out="$(run 0 0 1000 1000 0 0 "$R")"
[[ "$out" != *"CHANGED"* ]] && ok "same uid as last start → no warning" || bad "warned on no change: $out"

# 3. A non-root owner → matched, and said.
rm -f "$R"
out="$(run 501 20 1000 1000 0 0 "$R")"
[[ "$out" == *"usermod:501"* && "$out" == *"groupmod:20"* && "$out" == *"claude runs as 501:20 (matched)"* ]] \
    && [ "$(cat "$R")" = "501:20" ] \
    && ok "workspace reads 501:20 → claude matched to 501:20, said and recorded" \
    || bad "match case: $out"

# 3b. A failed usermod doesn't print "(matched)".
out="$( ( dbg() { :; }; stat() { case "$2" in %u) echo 501 ;; %g) echo 20 ;; esac; }
    id() { case "$1" in -u) echo 1000 ;; -g) echo 20 ;; esac; }
    usermod() { return 1; }; groupmod() { :; }; nproc() { echo 2; }; find() { :; }; xargs() { :; }; chown() { :; }
    . "$tmp/fn.sh"; _match_claude_uid "$tmp/ws" "" 2>&1 ) )"
[[ "$out" == *"usermod -u 501 claude FAILED"* && "$out" == *"(match FAILED)"* && "$out" != *"(matched)"* ]] \
    && ok "usermod fails → (match FAILED), not (matched)" || bad "failed-usermod wording: $out"

# 4. #141's sequence: last start was 501:20, this one reads 1000 → warned.
out="$(run 1000 1000 1000 1000 0 0 "$R")"
[[ "$out" == *"claude's uid CHANGED since the last start: 501:20 -> 1000:1000"* \
   && "$out" == *"named volumes under \$HOME, may not be writable"* ]] \
    && ok "uid changed between starts (501 → 1000, #141) → warned, with what it costs" \
    || bad "change not warned: $out"

# 5. The chown's rc is read.
out="$(run 1000 1000 1000 1000 123 0 "$R")"
[[ "$out" == *"chown of /home/claude to claude failed (find rc 0, xargs rc 123)"* ]] \
    && ok "chown pipeline fails (xargs rc 123) → reported, with both stages' rc" \
    || bad "chown failure silent: $out"
out="$(run 1000 1000 1000 1000 0 0 "$R")"
[[ "$out" != *"chown of /home/claude"* ]] && ok "chown succeeds → no failure line" || bad "false chown failure: $out"

# 6. No $HOME/.claude yet (brand-new project) → no record, no error, still the uid line.
out="$(run 0 0 1000 1000 0 0 "$tmp/missing/.dridock-claude-uid")"
[[ "$out" == *"claude runs as 1000:1000"* && "$out" != *"couldn't record"* ]] && [ ! -e "$tmp/missing" ] \
    && ok "\$HOME/.claude not created yet → nothing recorded, nothing created, no error" \
    || bad "missing-dir case: $out"

# 7. The record can't be written → said, since a future change would go unseen.
out="$(run 0 0 1000 1000 0 1 "$R")"
[[ "$out" == *"recorded claude's uid in $R but couldn't hand it to claude"* && "$out" != *"won't be noticed"* ]] \
    && ok "record written but chown fails → says it may not be updatable (not that nothing was recorded)" \
    || bad "record chown failure: $out"
if [ "$(command id -u)" = "0" ]; then
    echo "  SKIP: running as root, a chmod 500 dir doesn't stop the write"
else
    chmod 500 "$tmp/claude"
    out="$(run 0 0 1000 1000 0 0 "$tmp/claude/new-record")"
    chmod 700 "$tmp/claude"
    [[ "$out" == *"couldn't record claude's uid in $tmp/claude/new-record"*"Permission denied"* ]] \
        && ok "record not writable → said, with the real error" \
        || bad "record write failure: $out"
fi

# 8. No workspace dir → said, nothing remapped.
out="$( ( dbg() { :; }; id() { case "$1" in -u) echo 1000 ;; -g) echo 1000 ;; esac; }; . "$tmp/fn.sh"; _match_claude_uid "$tmp/nope" "$R" 2>&1 ) )"
[[ "$out" == *"no workspace dir to read"* ]] && ok "no workspace dir → said" || bad "no-workspace case: $out"

# 9. The entrypoint calls it UNCONDITIONALLY, so case 8 is reachable: a guard
#    around the call made "no workspace" a silent skip again (Arfy, #141).
local call
call="$(grep -nE '^[[:space:]]*_match_claude_uid "\$CLAUDE_WORKSPACE"' "$REPO/entrypoint.sh")"
if [ -n "$call" ] && [[ "$call" =~ ^[0-9]+:_match_claude_uid ]]; then
    ok "the entrypoint calls _match_claude_uid at top level, not behind a guard"
else
    bad "the call to _match_claude_uid is missing or indented (inside a condition?): '$call'"
fi

rm -rf "$tmp"
echo "  entrypoint uid match: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_entrypoint_uid_match)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_entrypoint_uid_match
fi

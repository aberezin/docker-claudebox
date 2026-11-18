#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# The stubs are read by the extracted function, which shellcheck can't see.
# shellcheck disable=SC2015,SC2034
# #141: the entrypoint's uid matching says what it did.
# #147: it matches only on a filesystem whose owner is real, and reconciles the
#       named volumes under $HOME to claude's actual uid on every start.
#
# WHY (#141): a container lifetime read the workspace as 501, so claude became
# 501 and $HOME was chowned to it; the next read 1000, and the 501-owned named
# volumes were unwritable. None of it was visible: the skip was silent, the
# chown's rc went nowhere, and the change between starts wasn't noticed.
#
# WHY (#147, #143): on a virtiofs share the workspace's presented owner follows
# whichever guest process last wrote into it, not the host owner, so matching
# against it flips claude's uid between lifetimes. And the chown that followed
# a match walked all of /home/claude (a share, with ~/.ssh in it) and ran only
# on the match path, so 501-stamped volumes stayed 501 after a skip.
#
# Takes _match_claude_uid and its mount helpers straight out of entrypoint.sh
# and runs them with stub functions for stat/id/usermod/groupmod/find/xargs/
# chown and a stub mount table, so it needs no root, no image and no daemon.

_EUM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_entrypoint_uid_match() {
local REPO="$_EUM_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- entrypoint: uid matching is observable (#141) and mount-aware (#147) ---"

local tmp; tmp="$(mktemp -d)"
awk '/^# >>> uid_mounts/,/^# <<< uid_mounts/; /^_match_claude_uid\(\) \{/,/^\}/' "$REPO/entrypoint.sh" > "$tmp/fn.sh"
if ! grep -q '^_match_claude_uid()' "$tmp/fn.sh" || ! grep -q '^_dridock_mount_table()' "$tmp/fn.sh"; then
    bad "couldn't extract _match_claude_uid and the uid_mounts block from entrypoint.sh: the cases below would test nothing"
    rm -rf "$tmp"; echo "  entrypoint uid match: $PASS passed, $FAIL failed"; return 1
fi

local H="$tmp/home" WS="$tmp/ws"
mkdir -p "$WS" "$tmp/claude" "$H"
# Mount tables, in real /proc/self/mountinfo format (optional fields vary).
# The live layout (#147, Arfy's argv read): $HOME is itself a virtiofs share,
# with ~/.ssh a share inside it and the named volumes ext4 inside it.
mi() {  # mi <file> <mountpoint> <fstype> [<mountpoint> <fstype> …]
    local f="$1"; shift; : > "$f"
    printf '1 0 0:1 / / rw shared:1 - overlay overlay rw\n' >> "$f"
    while [ $# -ge 2 ]; do
        printf '%s 1 0:%s / %s rw,relatime shared:%s master:1 - %s src rw\n' "$RANDOM" "$RANDOM" "$1" "$RANDOM" "$2" >> "$f"
        shift 2
    done
}
local LIVE="$tmp/mi.live" WSLOCAL="$tmp/mi.wslocal"
mi "$LIVE"    "$H" virtiofs "$H/.ssh" virtiofs "$H/.cache" ext4 "$WS" virtiofs
mi "$WSLOCAL" "$H" virtiofs "$H/.ssh" virtiofs "$H/.cache" ext4 "$WS" ext4

# One run in a subshell. Args: MOUNTINFO WS_UID WS_GID C_UID C_GID XARGS_RC CHOWN_RC RECORD.
# Prints stderr, then "CALLS: …" (each find shows its args) and "CLAUDE: uid:gid".
run() {
    (
        export _DRIDOCK_MOUNTINFO="$1" _DRIDOCK_HOME="$H"
        WS_UID="$2" WS_GID="$3" C_UID="$4" C_GID="$5" XARGS_RC="${6:-0}" CHOWN_RC="${7:-0}"
        RECORD="$8"
        CALLS=""
        dbg() { :; }
        stat() { case "$2" in %u) echo "$WS_UID" ;; %g) echo "$WS_GID" ;; esac; }
        id() { case "$1" in -u) echo "$C_UID" ;; -g) echo "$C_GID" ;; esac; }
        usermod() { CALLS+=" usermod:$2"; [ -n "${USERMOD_FAILS:-}" ] && return 1; C_UID="$2"; }
        groupmod() { CALLS+=" groupmod:$2"; C_GID="$2"; }
        nproc() { echo 4; }
        # find and xargs run as pipeline stages, i.e. in subshells, so they log
        # to a file: a CALLS+= there is lost, which made the old "nothing was
        # walked" assertion (#141) pass vacuously.
        : > "$tmp/pipe.log"
        find() { echo " find[$*]" >> "$tmp/pipe.log"; }
        xargs() { echo " xargs" >> "$tmp/pipe.log"; return "$XARGS_RC"; }
        chown() { return "$CHOWN_RC"; }
        # shellcheck disable=SC1091
        . "$tmp/fn.sh"
        _match_claude_uid "$WS" "$RECORD" 2>&1
        echo "CALLS:$CALLS$(tr -d '\n' < "$tmp/pipe.log")"
        echo "CLAUDE: $C_UID:$C_GID"
    )
}
local out R="$tmp/claude/.dridock-claude-uid"
# The roots walked, in order, with $tmp shortened to T.
finds() { printf '%s\n' "$1" | grep -o 'find\[[^]]*\]' | sed -e 's/^find\[//' -e 's/ -xdev.*//' -e "s#^$tmp#T#" | tr '\n' '|'; }

# 1. #143, the live case: workspace is a virtiofs share reading 501:20 → NOT
#    matched (its owner reading follows guest writes), and said.
out="$(run "$LIVE" 501 20 1000 1000 0 0 "$R")"
[[ "$out" == *"workspace reads 501:20, claude runs as 1000:1000 (skipped: the workspace is a virtiofs share, whose owner reading follows guest writes, not the host, see #143)"* ]] \
    && [[ "$out" != *usermod* && "$out" != *groupmod* ]] && [ "$(cat "$R")" = "1000:1000" ] \
    && ok "workspace on virtiofs reading 501:20 → no match, claude stays 1000, said and recorded (#143)" \
    || bad "virtiofs case: $out / record=$(cat "$R" 2>/dev/null)"
[[ "$out" != *"CHANGED"* ]] && ok "first record → no change warning" || bad "change warned with no prior record: $out"

# 2. Only the local mounts under $HOME are walked: the ext4 volume, never the
#    $HOME share or ~/.ssh. Every start, including this skip (#143's damage).
[ "$(finds "$out")" = "T/home/.cache|" ] \
    && ok "skip path still reconciles: only the ext4 volume is walked, not \$HOME or ~/.ssh (shares)" \
    || bad "walked roots: '$(finds "$out")' / $out"
[[ "$out" == *"find[$H/.cache -xdev ( ! -user 1000 -o ! -group 1000 )"* ]] \
    && ok "each walk is -xdev and selects by claude's actual uid (1000:1000)" \
    || bad "find args: $out"

# 2b. The reconcile is SAID at normal verbosity (dbg is stubbed out here, which
#     is a start with DRIDOCK_DEBUG off): otherwise the only line says
#     "skipped" while files were chowned (Arfy, #147 review).
[[ "$out" == *"dridock: uid: reconciled ownership to 1000:1000 under $H/.cache (only misowned files are changed) (#147)"* ]] \
    && ok "a reconcile prints a line at normal verbosity, naming the uid and the roots" \
    || bad "reconcile not said: $out"

# 3. Same again: record matches → no warning.
out="$(run "$LIVE" 501 20 1000 1000 0 0 "$R")"
[[ "$out" != *"CHANGED"* ]] && ok "same uid as last start → no warning" || bad "warned on no change: $out"

# 4. A LOCAL workspace (the Linux docker backend) still matches, and is said.
rm -f "$R"
out="$(run "$WSLOCAL" 501 20 1000 1000 0 0 "$R")"
[[ "$out" == *"usermod:501"* && "$out" == *"groupmod:20"* && "$out" == *"claude runs as 501:20 (matched)"* ]] \
    && [ "$(cat "$R")" = "501:20" ] \
    && ok "workspace on ext4 reading 501:20 → claude matched to 501:20, said and recorded" \
    || bad "local match case: $out"
[[ "$out" == *"find[$H/.cache -xdev ( ! -user 501 -o ! -group 20 )"* ]] \
    && ok "after a match the volume is reconciled to the NEW uid (501:20)" || bad "post-match walk: $out"

# 5. A local workspace reading as root → skipped, and said.
out="$(run "$WSLOCAL" 0 0 1000 1000 0 0 "")"
[[ "$out" == *"workspace reads 0:0, claude runs as 1000:1000 (skipped: the workspace reads as root)"* && "$out" != *usermod* ]] \
    && ok "local workspace reading as root → skip is SAID, nothing remapped" || bad "root case: $out"

# 6. usermod fails → the walk selects by the uid claude ACTUALLY has, not the
#    requested one (the inconsistency #147 fixes).
out="$(USERMOD_FAILS=1 run "$WSLOCAL" 501 20 1000 1000 0 0 "")"
[[ "$out" == *"usermod -u 501 claude FAILED"* && "$out" == *"(match FAILED)"* && "$out" != *"(matched)"* ]] \
    && ok "usermod fails → (match FAILED), not (matched)" || bad "failed-usermod wording: $out"
[[ "$out" == *"find[$H/.cache -xdev ( ! -user 1000 -o ! -group 20 )"* ]] \
    && ok "usermod fails → the walk targets the uid claude really has (1000), not the requested 501" \
    || bad "walk after a failed usermod: $out"

# 7. #141's sequence: last start was 501:20, this one runs as 1000 → warned,
#    and the warning says the volumes were reconciled.
printf '501:20\n' > "$R"
out="$(run "$LIVE" 0 0 1000 1000 0 0 "$R")"
[[ "$out" == *"claude's uid CHANGED since the last start: 501:20 -> 1000:1000"* \
   && "$out" == *"named volumes under \$HOME were reconciled to 1000:1000"* ]] \
    && ok "uid changed between starts (501 → 1000) → warned, and says the volumes were reconciled" \
    || bad "change not warned: $out"

# 8. The chown's rc is read, per walk.
out="$(run "$LIVE" 0 0 1000 1000 123 0 "")"
[[ "$out" == *"chown of $H/.cache to 1000:1000 failed (find rc 0, xargs rc 123)"* ]] \
    && ok "a walk's chown fails (xargs rc 123) → reported, naming the mount and both stages' rc" \
    || bad "chown failure silent: $out"
out="$(run "$LIVE" 0 0 1000 1000 0 0 "")"
[[ "$out" != *"chown of "* ]] && ok "chown succeeds → no failure line" || bad "false chown failure: $out"

# 9. $HOME itself local (no bind over it) → $HOME and the volume are walked
#    SEPARATELY, each -xdev, so neither walk crosses into the other.
local HL="$tmp/mi.homelocal"
mi "$HL" "$H/.cache" ext4 "$H/.ssh" virtiofs "$WS" virtiofs
out="$(run "$HL" 0 0 1000 1000 0 0 "")"
[ "$(finds "$out")" = "T/home|T/home/.cache|" ] && [[ "$out" == *"find[$H -xdev"* ]] \
    && ok "\$HOME on the container fs → \$HOME and the volume walked separately, both -xdev; ~/.ssh never" \
    || bad "home-local walks: '$(finds "$out")' / $out"

# 10. A share nested INSIDE a volume isn't walked; -xdev keeps the volume's walk
#     out of it (the topology where a missing -xdev and a right allowlist
#     still produce a wrong result together, Arfy).
local NEST="$tmp/mi.nested"
mi "$NEST" "$H" virtiofs "$H/.cache" ext4 "$H/.cache/hostshare" virtiofs "$WS" virtiofs
out="$(run "$NEST" 0 0 1000 1000 0 0 "")"
[ "$(finds "$out")" = "T/home/.cache|" ] && [[ "$out" == *"find[$H/.cache -xdev"* ]] \
    && ok "a share nested in a volume is not a root, and the volume's walk is -xdev" \
    || bad "nested: '$(finds "$out")' / $out"

# 11. An unrecognised fstype under $HOME → said, never walked.
local UNK="$tmp/mi.unknown"
mi "$UNK" "$H" virtiofs "$H/.cache" ext4 "$H/data" 9pfoo "$WS" virtiofs
out="$(run "$UNK" 0 0 1000 1000 0 0 "")"
[[ "$out" == *"$H/data is on '9pfoo', which isn't a known local or share filesystem: not reconciling"* ]] \
    && [ "$(finds "$out")" = "T/home/.cache|" ] \
    && ok "unknown fstype under \$HOME → said, not walked (an unknown type could be a host share)" \
    || bad "unknown fstype: $out"

# 12. A mount point with a space arrives octal-escaped (\040) → decoded and walked.
local SP="$tmp/mi.space"
mi "$SP" "$H" virtiofs "$WS" virtiofs
printf '99 1 0:9 / %s/my\\040vol rw - ext4 src rw\n' "$H" >> "$SP"
out="$(run "$SP" 0 0 1000 1000 0 0 "")"
[[ "$out" == *"find[$H/my vol -xdev"* ]] \
    && ok "a mount point with a space (\\040 in mountinfo) is decoded and walked" || bad "escaped mount point: $out"

# 13. Unreadable mount table → the workspace's filesystem is unknown: no match,
#     no walk, and it says so.
out="$(run "$tmp/no-such-mountinfo" 501 20 1000 1000 0 0 "")"
[[ "$out" == *"(skipped: the workspace's filesystem 'unreadable' isn't one whose owner can be trusted, see #147)"* ]] \
    && [[ "$out" != *usermod* && "$out" != *"find["* ]] \
    && ok "mount table unreadable → no match, nothing walked, and said" || bad "unreadable mountinfo: $out"
[[ "$out" != *"reconciled ownership"* ]] \
    && ok "nothing walked → no 'reconciled' line (it doesn't claim work it didn't do)" || bad "reconciled line with no roots: $out"

# 14. No $HOME/.claude yet (brand-new project) → no record, no error, still the uid line.
out="$(run "$LIVE" 0 0 1000 1000 0 0 "$tmp/missing/.dridock-claude-uid")"
[[ "$out" == *"claude runs as 1000:1000"* && "$out" != *"couldn't record"* ]] && [ ! -e "$tmp/missing" ] \
    && ok "\$HOME/.claude not created yet → nothing recorded, nothing created, no error" \
    || bad "missing-dir case: $out"

# 15. The record can't be written → said, since a future change would go unseen.
out="$(run "$LIVE" 0 0 1000 1000 0 1 "$R")"
[[ "$out" == *"recorded claude's uid in $R but couldn't hand it to claude"* && "$out" != *"won't be noticed"* ]] \
    && ok "record written but chown fails → says it may not be updatable (not that nothing was recorded)" \
    || bad "record chown failure: $out"
if [ "$(command id -u)" = "0" ]; then
    echo "  SKIP: running as root, a chmod 500 dir doesn't stop the write"
else
    chmod 500 "$tmp/claude"
    out="$(run "$LIVE" 0 0 1000 1000 0 0 "$tmp/claude/new-record")"
    chmod 700 "$tmp/claude"
    [[ "$out" == *"couldn't record claude's uid in $tmp/claude/new-record"*"Permission denied"* ]] \
        && ok "record not writable → said, with the real error" \
        || bad "record write failure: $out"
fi

# 16. No workspace dir → said, nothing remapped.
out="$( ( dbg() { :; }; id() { case "$1" in -u) echo 1000 ;; -g) echo 1000 ;; esac; }; . "$tmp/fn.sh"; _match_claude_uid "$tmp/nope" "$R" 2>&1 ) )"
[[ "$out" == *"no workspace dir to read"* ]] && ok "no workspace dir → said" || bad "no-workspace case: $out"

# 17. The entrypoint calls it UNCONDITIONALLY, so case 16 is reachable: a guard
#     around the call made "no workspace" a silent skip again (Arfy, #141).
local call
call="$(grep -nE '^[[:space:]]*_match_claude_uid "\$CLAUDE_WORKSPACE"' "$REPO/entrypoint.sh")"
if [ -n "$call" ] && [[ "$call" =~ ^[0-9]+:_match_claude_uid ]]; then
    ok "the entrypoint calls _match_claude_uid at top level, not behind a guard"
else
    bad "the call to _match_claude_uid is missing or indented (inside a condition?): '$call'"
fi

# 18. The old whole-$HOME walk is gone: /home/claude is a share of the Mac in
#     the live layout, with ~/.ssh inside it.
grep -qE 'find /home/claude ' "$REPO/entrypoint.sh" \
    && bad "entrypoint.sh still walks /home/claude unconditionally (it's a host share, ~/.ssh inside)" \
    || ok "no unconditional walk of /home/claude remains"

# 19. No outcome string contains ")": the status line wraps it in "(…)" and
#     readers (#149's checker) take the outcome up to the first ")", so a
#     nested "(#143)" truncated it in the first live run of #147.
local paren
paren="$(grep -nE '^[[:space:]]*how="[^"]*\)' "$REPO/entrypoint.sh")"
[ -z "$paren" ] && ok "no uid outcome string contains ')' (the line's own parens delimit it)" \
    || bad "an outcome string contains ')', which truncates it for every reader: $paren"

rm -rf "$tmp"
echo "  entrypoint uid match: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_entrypoint_uid_match)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_entrypoint_uid_match
fi

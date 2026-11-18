#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #149: the live uid test needs a docker daemon, so its CHECKER is extracted
# from tests/test_entrypoint.sh between its markers and driven here over
# synthetic container output — including the outputs that must be rejected.
#
# WHY: #141's live test used to assert that the mount presents the workspace as
# root. That is an environment fact the entrypoint neither controls nor
# promises, so 6.1.0 shipped with it red (#146's gate record) while the code did
# exactly what #141 specifies. The assertion is now the CONTRACT — the status
# line is true — and this file is what proves the check can fail. A checker
# verified only by the case where nothing is wrong is the #144 mistake again:
# every sed yielding "" would compare empty to empty and pass everything.

_ULC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_uid_line_contract() {
local REPO="$_ULC_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- the #141 uid line is checked for TRUTH, not for a uid (#149) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> uid_line_contract/,/^# <<< uid_line_contract/p' "$REPO/tests/test_entrypoint.sh" > "$fn"
if ! grep -q '^_uid_line_contract()' "$fn"; then
    bad "_uid_line_contract not found between the markers in tests/test_entrypoint.sh: the cases below would test nothing"
    rm -rf "$tmp"; echo "  uid line contract: $PASS passed, $FAIL failed"; return 1
fi
# shellcheck disable=SC1090
. "$fn"

local LINE='dridock: uid: workspace reads %s, claude runs as %s (%s) (#141)'
local SKIP='skipped: the workspace reads as root'
local SHARE='skipped: the workspace is a virtiofs share, whose owner reading follows guest writes, not the host, see #143'
local UNTRUSTED="skipped: the workspace's filesystem 'unreadable' isn't one whose owner can be trusted, see #147"
# verdict <pass|fail> <label> <said_ws> <said_claude> <how> <before_ws> <after_ws> <real_claude>
#
# before_ws and after_ws are deliberately separate (#149 review): on virtiofs
# the workspace's presented owner moves when a guest process modifies it, so
# the reading AFTER the entrypoint ran is not evidence about what it read. The
# line is held to the BEFORE reading; the after reading is printed only.
verdict() {
    local want="$1" label="$2" out rc=0
    out="$(printf 'WS0=%s\n' "$6"; printf "$LINE\n" "$3" "$4" "$5"; printf 'WS=%s CLAUDE=%s\n' "$7" "$8")"
    local got; got="$(_uid_line_contract "$out")" || rc=1
    local v=pass; [ "$rc" -ne 0 ] && v=fail
    [ "$v" = "$want" ] && ok "$want: $label" \
        || bad "expected $want, got $v — $label; checker said: $(printf '%s' "$got" | tr '\n' '|')"
}

# ── truthful lines: the contract holds, whatever the mount presented ─────────
verdict pass "root presentation, skipped, nothing remapped"            '0:0'      '1000:1000' "$SKIP"        '0:0'      '0:0'       '1000:1000'
verdict pass "501 presentation, matched — #143's flip is not a failure" '501:1000' '501:1000'  'matched'      '501:1000' '501:1000'  '501:1000'
verdict pass "the Mac's own ids presented, matched"                     '501:20'   '501:20'    'matched'      '501:20'   '501:20'    '501:20'
verdict pass "usermod failed and the line says so"                      '501:20'   '1000:1000' 'match FAILED' '501:20'   '501:20'    '1000:1000'
verdict pass "a root GID alone also triggers the skip"                   '501:0'    '1000:1000' "$SKIP"        '501:0'    '501:0'     '1000:1000'
verdict pass "#147: a virtiofs workspace reading 501 is skipped, claude 1000" '501:1000' '1000:1000' "$SHARE"     '501:1000' '501:1000'  '1000:1000'
verdict pass "#147: an untrusted filesystem is skipped, whatever it reads" '501:20'  '1000:1000' "$UNTRUSTED"  '501:20'   '501:20'    '1000:1000'

# ── Bear's live case: the presented owner MOVED during the run (#143) ───────
# The line said 0:0, a later stat said 1000:1000, and neither was wrong. The
# old `said_ws == real_ws` assertion failed this honest run; it must pass now.
verdict pass "the workspace's owner moved mid-run (0:0 -> 1000:1000), line truthful" \
                                                                        '0:0'      '1000:1000' "$SKIP"        '0:0'      '1000:1000' '1000:1000'
verdict pass "...and it moved the other way (501:1000 -> 0:0)"          '501:1000' '501:1000'  'matched'      '501:1000' '0:0'       '501:1000'

# ── lies: each must fail ────────────────────────────────────────────────────
verdict fail "says claude is 1000 while id says 501"                    '501:1000' '1000:1000' 'matched'      '501:1000' '501:1000'  '501:1000'
verdict fail "says it read 0:0 when the pre-read said 501:1000"         '0:0'      '1000:1000' "$SKIP"        '501:1000' '501:1000'  '1000:1000'
verdict fail "claims (matched) against a workspace it reports as other" '501:1000' '1000:1000' 'matched'      '501:1000' '501:1000'  '1000:1000'
verdict fail "claims (skipped) while reporting a non-root read"         '501:1000' '501:1000'  "$SKIP"        '501:1000' '501:1000'  '501:1000'
verdict fail "a share skip that misreports claude's uid"                 '501:1000' '501:1000'  "$SHARE"      '501:1000' '501:1000'  '1000:1000'
verdict fail "an outcome word nobody recognises"                        '0:0'      '1000:1000' 'whatever'     '0:0'      '0:0'       '1000:1000'
verdict fail "no pre-read at all: nothing to hold the line to"          '0:0'      '1000:1000' "$SKIP"        ''         '0:0'       '1000:1000'

# ── the format-drift trap: a parse that yields nothing must NOT pass ────────
local out rc got
out="$(printf 'WS0=501:1000\n'; printf 'dridock: uid: workspace reads 501, claude runs as 501 (matched)\n'; printf 'WS=501:1000 CLAUDE=501:1000\n')"
rc=0; got="$(_uid_line_contract "$out")" || rc=1
[ "$rc" -ne 0 ] && ok "fail: a drifted line format (no gid) is a parse failure, not a silent pass" \
    || bad "a line the checker couldn't parse was accepted: $(printf '%s' "$got" | tr '\n' '|')"
printf '%s\n' "$got" | grep -q "couldn't parse" \
    && ok "...and it says so" || bad "the parse failure wasn't reported"

out="$(printf 'WS0=0:0\n'; printf 'some other output entirely\n'; printf 'WS=0:0 CLAUDE=1000:1000\n')"
rc=0; got="$(_uid_line_contract "$out")" || rc=1
[ "$rc" -ne 0 ] && ok "fail: no uid line at all" || bad "a missing uid line was accepted"

# ── the #143 data row is always emitted, with the fresh inode's reading ─────
out="$(printf 'WS0=501:1000\n'; printf "$LINE\n" '501:1000' '501:1000' 'matched'; printf 'WS=501:1000 CLAUDE=501:1000\n')"
got="$(_uid_line_contract "$out")"
printf '%s\n' "$got" | grep -q '^UIDLINE ws=501:1000 claude=501:1000 wsbefore=501:1000 saidws=501:1000 how=matched$' \
    && ok "the UIDLINE row carries both readings, what the line said, and the outcome LAST (it has spaces)" \
    || bad "the UIDLINE row is missing or malformed: $(printf '%s' "$got" | tr '\n' '|')"
printf '%s\n' "$got" | grep -q 'container read workspace=501:1000 before / 501:1000 after' \
    && ok "both readings are printed on a PASS too, not only on a failure" \
    || bad "the pass path doesn't record the readings"

# ── the row must survive an outcome with spaces in it ───────────────────────
out="$(printf 'WS0=0:0\n'; printf "$LINE\n" '0:0' '1000:1000' "$SKIP"; printf 'WS=0:0 CLAUDE=1000:1000\n')"
got="$(_uid_line_contract "$out")"
printf '%s\n' "$got" | grep -q "^UIDLINE ws=0:0 claude=1000:1000 wsbefore=0:0 saidws=0:0 how=$SKIP\$" \
    && ok "a multi-word outcome survives the row intact, because how= is last" \
    || bad "the row mangled a multi-word outcome: $(printf '%s' "$got" | tr '\n' '|')"

# ── the ⚠️ must key off the OUTCOME, not off a reading (#149 review) ────────
# Keying it off the after-reading announced "claude was remapped to 1000:1000"
# for a run whose line said (skipped). Structural, since the branch lives in
# the caller rather than in the extracted block.
awk '/== colima\*/{f=1} f&&/case "\$how" in/{print "KEYED_ON_HOW"; exit} f&&/case "\$real_ws" in|case "\$said_ws" in/{print "KEYED_ON_A_READING"; exit}' \
    "$REPO/tests/test_entrypoint.sh" | grep -q KEYED_ON_HOW \
    && ok "the colima note keys off the outcome, so (skipped) can't be reported as a remap" \
    || bad "the colima note keys off a reading again (#149): a skipped run will be announced as a remap"

# ── the live test must not assert the presentation again ────────────────────
grep -q "documented no-op isn't holding" "$REPO/tests/test_entrypoint.sh" \
    && bad "tests/test_entrypoint.sh still fails on the mount's presentation (#149)" \
    || ok "the live test no longer fails on which uid the mount presents (#149)"

rm -rf "$tmp"
echo "  uid line contract: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_uid_line_contract)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_uid_line_contract
fi

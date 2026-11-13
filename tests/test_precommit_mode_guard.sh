#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #116: the pre-commit hook refuses a commit that drops a tracked file from
# 755 to 644, and the baked framework guidance warns against `sed -i` on the
# workspace mount.
#
# WHY: GNU `sed -i` on the virtiofs workspace share renames a temp file over
# the original and the mode doesn't survive, so a 755 script comes out 600 and
# git stages it as 644. entrypoint.sh lost its exec bit that way on #105 and
# #107, and only review caught it.
#
# Runs the real .githooks/pre-commit in a throwaway repo under mktemp. LOAD-
# BEARING: GIT_CONFIG_GLOBAL=/dev/null, because a global core.hooksPath (Alan
# has one, #113) would replace .git/hooks/ and the hook under test would never
# run, so every "refused" case would fail and every "allowed" case would pass
# for the wrong reason.

_PMG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_precommit_mode_guard() {
local REPO="$_PMG_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- pre-commit refuses a lost exec bit; guidance warns about sed -i (#116) ---"

local tmp; tmp="$(mktemp -d)"
local r="$tmp/repo" out rc
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
g() { git -C "$r" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

git init -q -b master "$r"
install -m 755 "$REPO/.githooks/pre-commit" "$r/.git/hooks/pre-commit"
printf '#!/bin/sh\necho hi\n' > "$r/run.sh"; chmod 755 "$r/run.sh"
printf '#!/bin/sh\n' > "$r/with space.sh"; chmod 755 "$r/with space.sh"
printf 'x\n' > "$r/data.txt"; chmod 644 "$r/data.txt"
g add -A && DRIDOCK_ALLOW_MASTER_COMMIT=1 g commit -qm init 2>/dev/null
g switch -qc 116-work

# 1. The flip is refused on a work branch, naming the file and the fix.
chmod 644 "$r/run.sh"; g add run.sh
out="$(g commit -qm flip 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [[ "$out" == *"lose their exec bit"* ]] && [[ "$out" == *"chmod +x run.sh && git add run.sh"* ]]; then
    ok "755 → 644 on a work branch: refused, names run.sh and the chmod fix"
else
    bad "755 → 644 not refused as expected (rc $rc): $out"
fi
[ "$(g log --oneline | wc -l)" -eq 1 ] && ok "nothing was committed" || bad "a commit landed despite the refusal"

# 2. A path with a space is named whole and the fix line is shell-quoted.
chmod 644 "$r/with space.sh"; g add -A
out="$(g commit -qm flip2 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [[ "$out" == *"       with space.sh"* ]] && [[ "$out" == *'chmod +x with\ space.sh'* ]]; then
    ok "a filename with a space is named whole, and the fix is quoted"
else
    bad "space-in-name handling wrong (rc $rc): $out"
fi

# 3. The override commits, and says so.
out="$(DRIDOCK_ALLOW_MODE_CHANGE=1 g commit -qm deliberate 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [[ "$out" == *"DRIDOCK_ALLOW_MODE_CHANGE=1"* ]] && [[ "$out" == *"run.sh"* ]]; then
    ok "DRIDOCK_ALLOW_MODE_CHANGE=1 commits, with a warning naming the files"
else
    bad "override didn't work (rc $rc): $out"
fi

# 4. Gaining the bit is fine.
chmod 755 "$r/run.sh"; g add run.sh
out="$(g commit -qm gain 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "644 → 755 is allowed" || bad "644 → 755 refused (rc $rc): $out"

# 5. A content edit that keeps the mode is fine (the in-place write path).
echo 'echo more' >> "$r/run.sh"; g add run.sh
out="$(g commit -qm edit 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "a content edit that keeps 755 is allowed" || bad "content edit refused (rc $rc): $out"

# 6. On master both guards still apply, the mode one first.
g switch -q master
chmod 644 "$r/run.sh"; g add run.sh
out="$(g commit -qm flip-master 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && [[ "$out" == *"lose their exec bit"* ]] \
    && ok "on master a flip is refused by the mode guard" || bad "master flip (rc $rc): $out"
out="$(DRIDOCK_ALLOW_MODE_CHANGE=1 g commit -qm flip-master 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && [[ "$out" == *"refusing to commit directly to 'master'"* ]] \
    && ok "the mode override doesn't bypass the master guard" || bad "master guard bypassed (rc $rc): $out"

# 7. The baked guidance carries the rule.
local ep="$REPO/entrypoint.sh"
if grep -q "Don't \`sed -i\` files on the workspace mount" "$ep" \
   && grep -q "git diff --cached --summary | grep 'mode change'" "$ep"; then
    ok "entrypoint.sh's baked guidance warns about sed -i and gives the check"
else
    bad "entrypoint.sh guidance section missing or changed"
fi

unset GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
rm -rf "$tmp"
echo "  pre-commit mode guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_precommit_mode_guard)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_precommit_mode_guard
fi

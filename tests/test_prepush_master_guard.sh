#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #137: the pre-push hook refuses to push master unless the commit is a tagged
# release, since master receives only releases and work goes to a
# release-X.Y.Z version branch.
#
# Runs the real .githooks/pre-push through real `git push` calls into a bare
# fixture remote under mktemp. LOAD-BEARING: GIT_CONFIG_GLOBAL=/dev/null, so a
# global core.hooksPath (Alan has one, #113) can't replace .git/hooks/ and make
# every "refused" case pass for the wrong reason.

_PPG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_prepush_master_guard() {
local REPO="$_PPG_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- pre-push: master only receives tagged releases (#137) ---"

local tmp; tmp="$(mktemp -d)"
local r="$tmp/repo" remote="$tmp/remote.git" out rc
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
g() { git -C "$r" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

git init -q --bare "$remote"
git init -q -b master "$r"
install -m 755 "$REPO/.githooks/pre-push" "$r/.git/hooks/pre-push"
g remote add origin "$remote"
echo a > "$r/a"; g add a; g commit -qm one

# 1. An untagged master push is refused, naming the way out.
out="$(g push -q origin master 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [[ "$out" == *"is not a tagged release (#137)"* ]] && [[ "$out" == *"release-X.Y.Z"* ]]; then
    ok "untagged master push refused, pointing at the version branch"
else
    bad "untagged master push not refused (rc $rc): $out"
fi
[ -z "$(git -C "$remote" rev-parse -q --verify refs/heads/master 2>/dev/null)" ] \
    && ok "nothing reached the remote's master" || bad "the remote's master moved despite the refusal"

# 2. Other branches push freely: version branches and issue branches.
out="$(g push -q origin master:release-6.0.0 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "pushing to release-6.0.0 is allowed" || bad "version-branch push refused (rc $rc): $out"
out="$(g push -q origin master:137-version-branches 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "pushing an issue branch is allowed" || bad "issue-branch push refused (rc $rc): $out"

# 3. A tagged release commit pushes to master.
g tag -a v6.0.0 -m v6.0.0
out="$(g push -q origin master 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "master at a v* tag pushes" || bad "tagged release push refused (rc $rc): $out"

# 4. A non-release tag doesn't count.
echo b > "$r/a"; g commit -qam two; g tag scratch-tag
out="$(g push -q origin master 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "a non-v tag doesn't make a commit a release" || bad "non-release tag let master through"

# 5. The override works, and says so.
out="$(DRIDOCK_ALLOW_MASTER_PUSH=1 g push -q origin master 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [[ "$out" == *"DRIDOCK_ALLOW_MASTER_PUSH=1"* ]] \
    && ok "DRIDOCK_ALLOW_MASTER_PUSH=1 pushes, with a warning" || bad "override failed (rc $rc): $out"

# 6. Only an exact vX.Y.Z counts: not a bare `v6`, not an `-rc`.
echo c > "$r/a"; g commit -qam three; g tag v6; g tag -a v6.1.0-rc1 -m rc
out="$(g push -q origin master 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "a v6 / v6.1.0-rc1 tag doesn't make a commit a release" || bad "loose tag let master through (rc $rc): $out"

# 7. A rewrite is refused even when the new tip is tagged (master is append-only).
g tag -a v6.1.0 -m v6.1.0
out="$(g push -q origin master 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "a tagged fast-forward pushes" || bad "tagged ff refused (rc $rc): $out"
g reset -q --hard HEAD~1; echo d > "$r/a"; g commit -qam rewritten; g tag -a v6.1.1 -m v6.1.1
out="$(g push -q --force origin master 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && [[ "$out" == *"refusing to rewrite 'master'"* ]]; then
    ok "a force-push rewriting master is refused, even with a v* tag on the new tip"
else
    bad "rewrite not refused (rc $rc): $out"
fi

# 8. Deleting master on the remote is refused too.
out="$(g push -q origin :master 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && [[ "$out" == *"refusing to delete 'master'"* ]] \
    && ok "deleting the remote master is refused" || bad "remote master deletion not refused (rc $rc): $out"

unset GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
rm -rf "$tmp"
echo "  pre-push master guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_prepush_master_guard)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_prepush_master_guard
fi

#!/usr/bin/env bash
# #86 — the UserPromptSubmit hook must notice when the INSTALLED dridock is
# behind the harness repo, and must stay silent everywhere else.
#
# WHY: on 2026-09-02 a full session shipped v5.0.0 → v5.1.1 while the binary on
# PATH was 4.3.3. Nothing compared the two. The #71 guard compares the fetcher's
# stamp against the INSTALLED binary — both agreed at 4.3.3 — so it correctly
# saw no drift while everything was stale, and a six-day-old fetcher silently
# dropped a message (#50).
#
# The silence case matters as much as the warning: an ordinary project has no
# meaningful "repo version", and a warning shown to users who did nothing wrong
# is worse than the bug it reports.
#
# No docker required.

_HV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_hook_version_drift() {
local REPO="$_HV_DIR/.."
local HOOK="$REPO/.claude/hooks/team-watch-user-prompt-submit.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

echo "--- hook: installed-vs-repo version drift (#86) ---"
if [ ! -f "$HOOK" ]; then
    bad "hook not found at $HOOK"; echo "  version drift: $PASS passed, $FAIL failed"; return 1
fi

# 1. harness repo, repo ahead of installed → warns
local saved out
saved="$(cat "$REPO/VERSION")"
echo "999.0.0" > "$REPO/VERSION"
out="$( cd "$REPO" && echo '{}' | bash "$HOOK" 2>&1 )"
printf '%s' "$saved" > "$REPO/VERSION"
case "$out" in
    *"run ./install.sh"*) ok "warns when the repo is ahead of the installed binary" ;;
    *) bad "no warning when repo (999.0.0) is ahead of installed" ;;
esac

# 2. versions equal → silent. Guards against nagging on every prompt.
out="$( cd "$REPO" && echo '{}' | bash "$HOOK" 2>&1 )"
case "$out" in
    *"run ./install.sh"*) bad "warned even though repo and installed agree" ;;
    *) ok "silent when repo and installed agree" ;;
esac

# 3. ordinary project (no harness fingerprint) → silent even WITH a VERSION file.
#    This is the regression that would hurt real users, not us.
local tmp; tmp="$(mktemp -d)"
mkdir -p "$tmp/.dridock"
printf 'id: x\n' > "$tmp/.dridock/config.yml"
printf 'agents:\n  - name: Arfy\n' > "$tmp/.dridock/agents.yml"
echo "999.0.0" > "$tmp/VERSION"
( cd "$tmp" && git init -q . 2>/dev/null )
out="$( cd "$tmp" && echo '{}' | bash "$HOOK" 2>&1 )"
rm -rf "$tmp"
case "$out" in
    *"run ./install.sh"*) bad "warned in an ordinary project — users would see this for no reason" ;;
    *) ok "silent in a project without the harness fingerprint" ;;
esac

# 4. the check must survive being run from a SUBDIRECTORY. Testing relative
#    paths instead of resolving the repo root is the defect this fix was
#    reviewed for on #85; it would skip silently here.
out="$( cd "$REPO/dridock-ts/src" 2>/dev/null && echo "999.0.0" > "$REPO/VERSION" && echo '{}' | bash "$HOOK" 2>&1 )"
printf '%s' "$saved" > "$REPO/VERSION"
case "$out" in
    *"run ./install.sh"*) ok "fires from a subdirectory (repo root resolved, not assumed)" ;;
    *) bad "silent from a subdirectory — the check is CWD-dependent" ;;
esac

echo "  version drift: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_hook_version_drift)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_hook_version_drift
fi

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
# HERMETIC (#108). This test used to write "999.0.0" into the repo's REAL
# VERSION file and put it back with `printf '%s' "$(cat VERSION)"` — which drops
# the trailing newline, so every run left the tree dirty, and an interrupted run
# left VERSION at 999.0.0 for the next commit to pick up. It also asked whatever
# `dridock` was on PATH for its version, so its result depended on the machine:
# in a container the shim refuses `--version` and two cases could never pass.
# Now it builds a throwaway fixture repo with the harness fingerprint, drives a
# stub `dridock` whose version the test sets, and points XDG at a temp dir so
# the hook can't touch the runner's real inbox. Nothing outside mktemp is
# written — and the last case asserts exactly that.
#
# No docker required.

_HV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_hook_version_drift() {
local REAL_REPO="$_HV_DIR/.."
local HOOK="$REAL_REPO/.claude/hooks/team-watch-user-prompt-submit.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

echo "--- hook: installed-vs-repo version drift (#86) ---"
if [ ! -f "$HOOK" ]; then
    bad "hook not found at $HOOK"; echo "  version drift: $PASS passed, $FAIL failed"; return 1
fi

local real_version_before; real_version_before="$(od -c "$REAL_REPO/VERSION" 2>/dev/null)"

local tmp stub xdg fx
tmp="$(mktemp -d)"; stub="$tmp/bin"; xdg="$tmp/xdg"; fx="$tmp/harness"
mkdir -p "$stub" "$xdg" "$fx/dridock-ts/src/domain" "$fx/sub/dir"

# Stub dridock: answers the hook's gates, reports $HV_INSTALLED as its version,
# and makes `team watch` exit at once so a respawn attempt can't linger.
cat > "$stub/dridock" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    # Empty HV_INSTALLED = unreadable: no stdout, non-zero, like the container
    # shim (which refuses `--version` on stderr).
    "--version ")   [ -n "${HV_INSTALLED:-}" ] || { echo "refused" >&2; exit 1; }
                    echo "dridock $HV_INSTALLED"; exit 0 ;;
    "team roster")  exit 0 ;;
    "team whoami")  echo "Tester"; exit 0 ;;
    *)              exit 0 ;;
esac
STUB
chmod +x "$stub/dridock"

# Fixture harness repo: the hook recognises one by dridockVersion.ts + VERSION
# at the git toplevel.
: > "$fx/dridock-ts/src/domain/dridockVersion.ts"
( cd "$fx" && git init -q . 2>/dev/null )

# run <dir> <repo-version|""> <installed-version>
_hv_run() {
    [ -n "$2" ] && printf '%s\n' "$2" > "$fx/VERSION"
    ( cd "$1" && echo '{}' | env -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
        PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" HV_INSTALLED="$3" bash "$HOOK" 2>&1 )
}

local out

# 1. harness repo, repo ahead of installed → warns
out="$(_hv_run "$fx" 999.0.0 5.14.0)"
case "$out" in
    *"run ./install.sh"*) ok "warns when the repo is ahead of the installed binary" ;;
    *) bad "no warning when repo (999.0.0) is ahead of installed (5.14.0); got: $(printf '%s' "$out" | head -3)" ;;
esac

# 2. versions equal → silent. Guards against nagging on every prompt.
out="$(_hv_run "$fx" 5.14.0 5.14.0)"
case "$out" in
    *"run ./install.sh"*) bad "warned even though repo and installed agree" ;;
    *) ok "silent when repo and installed agree" ;;
esac

# 3. ordinary project (no harness fingerprint) → silent even WITH a VERSION file.
#    This is the regression that would hurt real users, not us.
local plain="$tmp/plain"
mkdir -p "$plain/.dridock"
printf 'id: x\n' > "$plain/.dridock/config.yml"
printf 'agents:\n  - name: Arfy\n' > "$plain/.dridock/agents.yml"
echo "999.0.0" > "$plain/VERSION"
( cd "$plain" && git init -q . 2>/dev/null )
out="$(_hv_run "$plain" "" 5.14.0)"
case "$out" in
    *"run ./install.sh"*) bad "warned in an ordinary project — users would see this for no reason" ;;
    *) ok "silent in a project without the harness fingerprint" ;;
esac

# 4. the check must survive being run from a SUBDIRECTORY. Testing relative
#    paths instead of resolving the repo root is the defect this fix was
#    reviewed for on #85; it would skip silently here.
out="$(_hv_run "$fx/sub/dir" 999.0.0 5.14.0)"
case "$out" in
    *"run ./install.sh"*) ok "fires from a subdirectory (repo root resolved, not assumed)" ;;
    *) bad "silent from a subdirectory — the check is CWD-dependent" ;;
esac

# 5. an installed version the hook can't read → silent, not a false alarm.
out="$(_hv_run "$fx" 999.0.0 "")"
case "$out" in
    *"run ./install.sh"*) bad "warned with no readable installed version" ;;
    *) ok "silent when the installed version can't be read" ;;
esac

rm -rf "$tmp"

# 6. #108's own regression: nothing outside mktemp was touched. Byte-compared,
#    so a dropped trailing newline counts as a change.
if [ "$(od -c "$REAL_REPO/VERSION" 2>/dev/null)" = "$real_version_before" ]; then
    ok "the real repo VERSION is byte-for-byte untouched (#108)"
else
    bad "the real repo VERSION changed during the test (#108 regression)"
fi

echo "  version drift: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_hook_version_drift)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_hook_version_drift
fi

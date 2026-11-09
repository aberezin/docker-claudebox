#!/bin/bash

# ── #104: .githooks/install.sh distributes every hook, and says so when it can't ──
#
# `make hooks` was `install -m 755 .githooks/pre-commit .git/hooks/pre-commit`:
# one named hook, a once-per-clone step people skip (Bear's clone held only
# `*.sample` two months after CLAUDE.md required it), and no detection at all
# for a copy that had gone stale or for a `core.hooksPath` that makes
# `.git/hooks/` dead weight.
#
# These run on the HOST with no container and no Docker: the installer is pure
# shell over a git worktree, so each case gets its own `git init` fixture. That
# is deliberate and it is the whole point of the design — a test that asserted
# against THIS clone's `.git/hooks/` would be asserting about the operator's
# machine, which is how tests/test_hook_version_drift.sh case 2 ends up red for
# reasons unrelated to the code.
#
# GIT_CONFIG_GLOBAL/SYSTEM are redirected at temp files so the hooksPath cases
# neither read nor write the real user's gitconfig.

test_githooks_install() {
    local PASS=0 FAIL=0
    local REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    local INSTALLER="$REPO/.githooks/install.sh"
    local tmp; tmp="$(mktemp -d)"

    _ok()  { echo "  ok   $1"; PASS=$((PASS+1)); }
    _bad() { echo "  FAIL $1"; FAIL=$((FAIL+1)); }

    echo "--- #104 git hook distribution ---"

    # ── self-check: the thing under test is really there ────────────────────
    # Every assertion below shells out to $INSTALLER. If it moved, they would
    # all fail identically with rc 127 and the reason would be unobvious.
    if [ -f "$INSTALLER" ]; then
        _ok "installer present at .githooks/install.sh"
    else
        _bad "no .githooks/install.sh — every case below is vacuous"
        echo "  #104 git hooks: $PASS passed, $FAIL failed"
        return 1
    fi

    export GIT_CONFIG_GLOBAL="$tmp/gitconfig-global"
    export GIT_CONFIG_SYSTEM="$tmp/gitconfig-system"
    : > "$GIT_CONFIG_GLOBAL"; : > "$GIT_CONFIG_SYSTEM"

    # Build a throwaway worktree that ships $* as hook files.
    _mkfixture() {
        local d="$tmp/$1"; shift
        rm -rf "$d"; mkdir -p "$d/.githooks"
        git init -q "$d" 2>/dev/null
        cp "$INSTALLER" "$d/.githooks/install.sh"
        local h
        for h in "$@"; do
            printf '#!/usr/bin/env bash\n# fixture hook %s\nexit 0\n' "$h" > "$d/.githooks/$h"
        done
        echo "$d"
    }

    local d out rc

    # ── 1. a fresh clone: the hook is MISSING and --check says so ───────────
    d="$(_mkfixture fresh pre-commit)"
    [ -f "$d/.githooks/pre-commit" ] || _bad "fixture hook was never written — case 1 is vacuous"
    out="$(bash "$d/.githooks/install.sh" --check 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'MISSING'; then
        _ok "--check on a fresh clone reports MISSING, rc $rc"
    else
        _bad "--check on a fresh clone gave rc $rc: $out"
    fi

    # ── 2. install puts it where git looks, executable and byte-identical ───
    out="$(bash "$d/.githooks/install.sh" 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ]; then _ok "install exits 0"; else _bad "install exited $rc: $out"; fi
    if [ -f "$d/.git/hooks/pre-commit" ]; then
        _ok "hook landed in .git/hooks/ (branch-independent, not core.hooksPath)"
    else
        _bad "nothing at $d/.git/hooks/pre-commit after install"
    fi
    if cmp -s "$d/.githooks/pre-commit" "$d/.git/hooks/pre-commit"; then
        _ok "installed copy is byte-identical to the tracked hook"
    else
        _bad "installed copy differs from .githooks/pre-commit"
    fi
    if [ "$(stat -c %a "$d/.git/hooks/pre-commit" 2>/dev/null)" = "755" ]; then
        _ok "installed mode is 755 (git skips a non-executable hook in silence)"
    else
        _bad "installed mode is $(stat -c %a "$d/.git/hooks/pre-commit" 2>/dev/null), expected 755"
    fi

    # ── 3. idempotent, and --check is then silent ───────────────────────────
    bash "$d/.githooks/install.sh" >/dev/null 2>&1
    out="$(bash "$d/.githooks/install.sh" --check 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
        _ok "--check is rc 0 and SILENT once current (no context noise on resume)"
    else
        _bad "--check after install gave rc $rc and ${#out} bytes: $out"
    fi

    # ── 4. a stale copy is detected, and refreshed ──────────────────────────
    # The quiet failure: installed, executable, passing, and out of date.
    echo '# drifted' >> "$d/.git/hooks/pre-commit"
    out="$(bash "$d/.githooks/install.sh" --check 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'STALE'; then
        _ok "a drifted copy reports STALE, rc $rc"
    else
        _bad "drifted copy gave rc $rc: $out"
    fi
    bash "$d/.githooks/install.sh" >/dev/null 2>&1
    if cmp -s "$d/.githooks/pre-commit" "$d/.git/hooks/pre-commit"; then
        _ok "re-running the installer refreshes the stale copy"
    else
        _bad "stale copy survived a re-install"
    fi

    # ── 5. every shipped hook is installed, not just pre-commit ─────────────
    # The original one-liner named pre-commit; adding a second hook would have
    # needed a second line nobody would remember. This is that regression.
    d="$(_mkfixture multi pre-commit pre-push commit-msg)"
    bash "$d/.githooks/install.sh" >/dev/null 2>&1
    local missing="" h
    for h in pre-commit pre-push commit-msg; do
        [ -f "$d/.git/hooks/$h" ] || missing="${missing:+$missing }$h"
    done
    if [ -z "$missing" ]; then
        _ok "all three shipped hooks installed (pre-commit, pre-push, commit-msg)"
    else
        _bad "not installed: $missing — the installer is still naming hooks individually"
    fi

    # ── 6. the installer itself is not installed as a hook ──────────────────
    if [ ! -e "$d/.git/hooks/install.sh" ]; then
        _ok ".githooks/install.sh is tooling, not copied as a hook"
    else
        _bad ".git/hooks/install.sh exists — the installer installed itself"
    fi

    # ── 7. a hook named out of shell habit is REFUSED, not skipped ──────────
    # `pre-push.sh` is the mistake this rule invites: git never calls it, so a
    # silent skip would be the exact never-silently-discard violation.
    d="$(_mkfixture extension pre-commit)"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$d/.githooks/pre-push.sh"
    out="$(bash "$d/.githooks/install.sh" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'pre-push.sh'; then
        _ok "pre-push.sh is refused loudly (rc $rc) rather than skipped"
    else
        _bad "pre-push.sh gave rc $rc: $out"
    fi
    if [ ! -e "$d/.git/hooks/pre-push.sh" ] && [ ! -e "$d/.git/hooks/pre-push" ]; then
        _ok "the mis-named file is not installed under either name"
    else
        _bad "pre-push.sh was installed anyway"
    fi
    # ...and the VALID hook beside it still gets installed — one bad name must
    # not take the rest of the distribution down with it.
    if [ -f "$d/.git/hooks/pre-commit" ]; then
        _ok "a refusal does not block the other hooks"
    else
        _bad "pre-commit was not installed when pre-push.sh was refused"
    fi

    # ── 8. a name git does not recognise is refused ─────────────────────────
    d="$(_mkfixture badname)"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$d/.githooks/precommit"
    out="$(bash "$d/.githooks/install.sh" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'precommit'; then
        _ok "'precommit' (not a git hook name) is refused, rc $rc"
    else
        _bad "'precommit' gave rc $rc: $out"
    fi

    # ── 9. core.hooksPath shadows .git/hooks — the no-other-symptom case ────
    d="$(_mkfixture shadowed pre-commit)"
    git -C "$d" config core.hooksPath .githooks
    out="$(bash "$d/.githooks/install.sh" --check 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'core.hooksPath'; then
        _ok "a locally-set core.hooksPath is reported (rc $rc) — install would be a no-op"
    else
        _bad "local core.hooksPath gave rc $rc: $out"
    fi
    if printf '%s' "$out" | grep -q 'this repo'; then
        _ok "the message names the scope as this repo, so the fix is unambiguous"
    else
        _bad "the hooksPath message does not say which scope set it: $out"
    fi
    # Global scope must be named differently: `--unset` in the wrong scope is a
    # command that reports success and changes nothing.
    git -C "$d" config --unset core.hooksPath
    git config --global core.hooksPath /somewhere/else
    out="$(bash "$d/.githooks/install.sh" --check 2>&1)"
    if printf '%s' "$out" | grep -q 'GLOBAL'; then
        _ok "a globally-set core.hooksPath is reported as GLOBAL, not as this repo"
    else
        _bad "global core.hooksPath was not identified as global: $out"
    fi
    git config --global --unset core.hooksPath

    # ── 10. sentinel: an empty .githooks/ must not read as success ──────────
    d="$(_mkfixture empty)"
    out="$(bash "$d/.githooks/install.sh" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'without doing anything'; then
        _ok "no installable hooks → loud failure, not a clean exit 0"
    else
        _bad "empty .githooks/ gave rc $rc: $out"
    fi

    # ── 11. structural: the surfaces people actually use call the installer ─
    # A distributor nothing invokes is the shape of the original defect.
    if grep -q 'bash .githooks/install.sh' "$REPO/Makefile"; then
        _ok "make hooks delegates to the installer"
    else
        _bad "Makefile no longer calls .githooks/install.sh — make hooks has drifted back"
    fi
    # Match the INVOCATION, not a mention. First draft grepped for the path and
    # stayed green when the `bash ...` line was broken, because the `[ -f ... ]`
    # guard two lines up still contained the string — a test passing for the
    # wrong reason, which is this repo's recurring shape.
    if grep -qF 'bash "$SCRIPT_DIR/.githooks/install.sh"' "$REPO/install.sh"; then
        _ok "root install.sh RUNS the installer (the command everyone already runs)"
    else
        _bad "install.sh does not invoke the hook installer — the step is once-per-clone again"
    fi
    # ...and BEFORE the image build, or a failed build means no hook.
    local _l_hook _l_build
    _l_hook="$(grep -nF 'bash "$SCRIPT_DIR/.githooks/install.sh"' "$REPO/install.sh" | head -1 | cut -d: -f1)"
    _l_build="$(grep -n 'docker --context "\$CB_INFRA_CTX" build' "$REPO/install.sh" | head -1 | cut -d: -f1)"
    if [ -n "$_l_hook" ] && [ -n "$_l_build" ] && [ "$_l_hook" -lt "$_l_build" ]; then
        _ok "the hook install runs before the image build (line $_l_hook < $_l_build)"
    else
        _bad "hook install at line '$_l_hook' is not before the build at '$_l_build'"
    fi
    if grep -q 'githooks-session-start.sh' "$REPO/.claude/settings.json"; then
        _ok "the SessionStart check is registered in .claude/settings.json"
    else
        _bad "githooks-session-start.sh is not wired into settings.json — it never runs"
    fi

    # ── 12. end-to-end: the REAL hook, installed by this installer, refuses ─
    # Everything above uses stub hooks, which proves distribution and says
    # nothing about the artifact distributed. This installs the repo's actual
    # .githooks/pre-commit into a fixture and drives `git commit` through it,
    # so "the guard is installed" and "the guard works" are one assertion.
    d="$(_mkfixture e2e)"
    cp "$REPO/.githooks/pre-commit" "$d/.githooks/pre-commit"
    bash "$d/.githooks/install.sh" >/dev/null 2>&1
    git -C "$d" symbolic-ref HEAD refs/heads/master
    echo hi > "$d/f.txt"; git -C "$d" add f.txt
    out="$(git -C "$d" -c user.name=t -c user.email=t@t commit -m 'on master' 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'refusing to commit directly'; then
        _ok "the installed real hook refuses a commit on master (rc $rc)"
    else
        _bad "a commit on master succeeded or failed for another reason (rc $rc): $out"
    fi
    # Sentinel: a hook that refuses EVERYTHING would pass the line above while
    # making the repo unusable. The same commit must land on a work branch.
    git -C "$d" checkout -q -b 104-fixture
    out="$(git -C "$d" -c user.name=t -c user.email=t@t commit -m 'on a branch' 2>&1)"; rc=$?
    if [ "$rc" -eq 0 ]; then
        _ok "the same commit lands on a work branch (the guard is branch-specific)"
    else
        _bad "commit on a work branch was also refused (rc $rc): $out"
    fi

    rm -rf "$tmp"
    unset GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM
    echo "  #104 git hooks: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_githooks_install)

# Direct invocation (not sourced by test.sh) → run it now.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    test_githooks_install
fi

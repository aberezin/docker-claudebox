#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #124: every shipped feature carries a check.sh, and each one tells "installed"
# from "marked installed".
#
# WHY: a feature's marker (~/.claude/.feature-<name>) records that on.sh ran
# once, not that what it installed is still there (#75). The entrypoint trusts
# the marker alone for any feature without a check.sh, so a payload that went
# missing (a plugin uninstalled, a hook overwritten, or modeguard's "not a git
# repo yet" deferral) leaves the feature reported enabled and doing nothing,
# silently. Making check.sh mandatory, by test, is what stops the next feature
# from shipping without one.
#
# Runs each check.sh against a fixture CLAUDE_CONFIG_DIR / workspace under
# mktemp. No image, no docker, no claude CLI.

_FC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_feature_checks() {
local REPO="$_FC_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- every feature ships a check.sh that verifies its payload (#124) ---"

# 1. The invariant: an executable check.sh with a summary line, in every feature.
local d f n=0
for d in "$REPO"/features/*/; do
    f="${d%/}"; f="${f##*/}"; n=$((n + 1))
    if [ -x "$d/check.sh" ] && grep -q '^# summary:' "$d/check.sh"; then
        ok "features/$f has an executable check.sh with a summary"
    else
        bad "features/$f has no executable check.sh with a '# summary:' line"
    fi
done
[ "$n" -ge 5 ] && ok "found $n features (the glob matched)" || bad "found only $n features: the glob is wrong, so the invariant checked nothing"

local tmp; tmp="$(mktemp -d)"
local cfg="$tmp/cfg" rc

# 2. The plugin-backed features: present only when the plugin db names it AND its dir exists.
if command -v jq >/dev/null 2>&1; then
    local pair feat plugin
    for pair in go:gopls-lsp python:pyright-lsp typescript:typescript-lsp; do
        feat="${pair%%:*}"; plugin="${pair#*:}"
        rm -rf "$cfg"; mkdir -p "$cfg/plugins/cache/$plugin"
        chk() { CLAUDE_CONFIG_DIR="$cfg" bash "$REPO/features/$feat/check.sh" >/dev/null 2>&1; }

        chk; rc=$?
        [ "$rc" -ne 0 ] && ok "$feat: no plugin db → not installed (rc $rc)" || bad "$feat: passed with no plugin db"

        printf '{"version":2,"plugins":{"%s@claude-plugins-official":[{"scope":"user","installPath":"%s"}]}}\n' \
            "$plugin" "$cfg/plugins/cache/$plugin" > "$cfg/plugins/installed_plugins.json"
        chk; rc=$?
        [ "$rc" -eq 0 ] && ok "$feat: plugin listed and its dir present → installed" || bad "$feat: real install reported missing (rc $rc)"

        rm -rf "$cfg/plugins/cache/$plugin"
        chk; rc=$?
        [ "$rc" -ne 0 ] && ok "$feat: plugin listed but its dir gone → not installed" || bad "$feat: passed with the install dir removed"

        printf '{"version":2,"plugins":{"other@x":[{"installPath":"%s"}]}}\n' "$cfg" > "$cfg/plugins/installed_plugins.json"
        chk; rc=$?
        [ "$rc" -ne 0 ] && ok "$feat: a different plugin listed → not installed" || bad "$feat: passed when only another plugin was installed"
    done
else
    echo "  skip plugin-backed checks: jq not on PATH here (it is baked in the image) — not a pass"
fi

# 3. modeguard: the "not a git repo yet" deferral must not stick once git exists.
local ws="$tmp/ws"
mg() { DRIDOCK_WORKSPACE="$ws" bash "$REPO/features/modeguard/check.sh" >/dev/null 2>&1; }
mkdir -p "$ws"
mg; rc=$?
[ "$rc" -eq 0 ] && ok "modeguard: no .git yet → passes (nothing to guard)" || bad "modeguard: failed in a non-git workspace (rc $rc)"

GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git init -q "$ws"   # no global init.templateDir hooks
mg; rc=$?
[ "$rc" -ne 0 ] && ok "modeguard: git now exists, no hook → not installed (so on.sh runs)" || bad "modeguard: passed with no hook in a git repo"

DRIDOCK_WORKSPACE="$ws" bash "$REPO/features/modeguard/on.sh" >/dev/null 2>&1
mg; rc=$?
[ "$rc" -eq 0 ] && ok "modeguard: after on.sh installs the hook → installed" || bad "modeguard: on.sh's own hook not recognised (rc $rc)"

printf '#!/bin/sh\nexit 0\n' > "$ws/.git/hooks/pre-commit"
mg; rc=$?
[ "$rc" -ne 0 ] && ok "modeguard: a foreign pre-commit hook → not installed" || bad "modeguard: a foreign hook passed as ours"

rm -rf "$tmp"
echo "  feature checks: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_feature_checks)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_feature_checks
fi

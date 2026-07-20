#!/usr/bin/env bash
# summary: remove the modeguard pre-commit hook (leaves user-authored hooks untouched)
# Idempotent. Only removes the hook we installed (detected by marker); silent no-op
# if the file is missing or belongs to the user.
set -uo pipefail

WS="${DRIDOCK_WORKSPACE:-/workspace}"
HOOK="$WS/.git/hooks/pre-commit"
MARKER="# dridock-modeguard"

if [ -f "$HOOK" ] && grep -qF "$MARKER" "$HOOK"; then
    rm -f "$HOOK"
    echo "modeguard: removed $HOOK"
fi

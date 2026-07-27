#!/usr/bin/env bash
# Claude Code statusLine — shows the dridock colima profile for the current
# project as `🚢 cb-<id>`. Silent when the cwd isn't in a dridock project so
# the statusLine stays empty in non-harness projects.
#
# Reads .dridock/config.yml directly (no `dridock` binary shell-out) so the
# hook stays sub-millisecond even on cold caches. Walks upward from the
# starting dir to catch the case where the user cd'd into a subdir.
#
# Input contract (Claude Code): a JSON payload on stdin with a `.cwd` field.
# Falls back to $CLAUDE_PROJECT_DIR then $PWD if stdin is empty or lacks jq.
# Output: one line to stdout (may be empty).
set -u

# ── resolve starting dir ─────────────────────────────────────────────
input="$(cat 2>/dev/null || true)"
cwd=""
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
    cwd="$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null)"
fi
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$cwd" ] || exit 0

# ── walk up looking for .dridock/config.yml ──────────────────────────
dir="$cwd"
while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -f "$dir/.dridock/config.yml" ]; then
        id=$(sed -nE 's/^id:[[:space:]]*([A-Za-z0-9_-]+).*$/\1/p' "$dir/.dridock/config.yml" | head -1)
        if [ -n "$id" ] && [ "$id" != "auto" ]; then
            # Cyan for readability on both light + dark terminals. Emoji ship
            # marks it as harness-context; text says the profile the user needs
            # for colima/docker/limactl.
            printf '\033[36m🚢 cb-%s\033[0m' "$id"
        fi
        exit 0
    fi
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
done
# Not in a dridock project: silent (empty statusLine).

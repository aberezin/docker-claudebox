#!/usr/bin/env bash
# summary: verify the pyright-lsp Claude plugin is still installed (not just marked)
# Run by the entrypoint when the feature's marker exists (#75, #124). Exit 0 =
# present, non-zero = reinstall via on.sh. on.sh installs one thing, the
# pyright-lsp plugin at user scope, and that lands in ~/.claude/plugins on the
# mount, so a container recreate does NOT lose it. What this catches is drift:
# the plugin uninstalled or its cache dir removed while the marker stayed.
# The language server binary is baked into the image and is not checked here;
# reinstalling the plugin couldn't bring it back.
set -uo pipefail
_db="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json"
[ -f "$_db" ] || exit 1
_path="$(jq -r '(.plugins // .)["pyright-lsp@claude-plugins-official"][0].installPath // empty' "$_db" 2>/dev/null)"
[ -n "$_path" ] && [ -d "$_path" ]

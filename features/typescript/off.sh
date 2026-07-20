#!/usr/bin/env bash
# summary: disable the typescript-lsp Claude plugin (server stays baked; only the plugin toggles off)
set -uo pipefail
claude plugin uninstall typescript-lsp@claude-plugins-official --scope user >/dev/null 2>&1 || true

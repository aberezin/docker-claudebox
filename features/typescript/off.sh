#!/usr/bin/env bash
# summary: disable the typescript-lsp Claude plugin (server stays baked; only the plugin toggles off)
set -uo pipefail
# #129 (B): a failed uninstall used to report the feature disabled with the plugin still in place.
claude plugin uninstall typescript-lsp@claude-plugins-official --scope user >/dev/null 2>&1 \
    || echo "typescript off: couldn't uninstall typescript-lsp (already gone, or check: claude plugin list)" >&2  # swallow-ok: B, the line itself is the trace

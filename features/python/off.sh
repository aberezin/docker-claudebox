#!/usr/bin/env bash
# summary: disable the pyright-lsp Claude plugin (server stays baked; only the plugin toggles off)
set -uo pipefail
# #129 (B): a failed uninstall used to report the feature disabled with the plugin still in place.
claude plugin uninstall pyright-lsp@claude-plugins-official --scope user >/dev/null 2>&1 \
    || echo "python off: couldn't uninstall pyright-lsp (already gone, or check: claude plugin list)" >&2  # swallow-ok: B, the line itself is the trace

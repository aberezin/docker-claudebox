#!/usr/bin/env bash
# summary: disable the gopls-lsp Claude plugin (gopls server stays baked; only the plugin toggles off)
# Called by `dridock features disable go`. The wrapper removes `go` from features:
# in .dridock/config.yml and clears the enable marker; this script uninstalls the
# plugin so the LSP stops firing on .go files. Idempotent — silent no-op if the
# plugin isn't installed.
set -uo pipefail
# #129 (B): a failed uninstall used to report the feature disabled with the plugin still in place.
claude plugin uninstall gopls-lsp@claude-plugins-official --scope user >/dev/null 2>&1 \
    || echo "go off: couldn't uninstall gopls-lsp (already gone, or check: claude plugin list)" >&2  # swallow-ok: B, the line itself is the trace

#!/usr/bin/env bash
# summary: disable the gopls-lsp Claude plugin (gopls server stays baked; only the plugin toggles off)
# Called by `dridock features disable go`. The wrapper removes `go` from features:
# in .dridock/config.yml and clears the enable marker; this script uninstalls the
# plugin so the LSP stops firing on .go files. Idempotent — silent no-op if the
# plugin isn't installed.
set -uo pipefail
claude plugin uninstall gopls-lsp@claude-plugins-official --scope user >/dev/null 2>&1 || true

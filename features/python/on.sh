#!/usr/bin/env bash
# summary: enable the pyright-lsp Claude plugin (pyright server baked into the image)
set -uo pipefail
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install pyright-lsp@claude-plugins-official --scope user

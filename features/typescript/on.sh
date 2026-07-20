#!/usr/bin/env bash
# summary: enable the typescript-lsp Claude plugin (typescript-language-server baked into the image)
set -uo pipefail
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install typescript-lsp@claude-plugins-official --scope user

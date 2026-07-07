#!/usr/bin/env bash
# summary: Go code intelligence — gopls-lsp plugin (gopls server baked)
set -uo pipefail
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install gopls-lsp@claude-plugins-official --scope user

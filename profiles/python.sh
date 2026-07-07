#!/usr/bin/env bash
# summary: Python code intelligence — pyright-lsp plugin (pyright server baked)
set -uo pipefail
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install pyright-lsp@claude-plugins-official --scope user

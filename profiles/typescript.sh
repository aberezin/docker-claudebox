#!/usr/bin/env bash
# summary: TypeScript/JavaScript code intelligence — typescript-lsp plugin (server baked)
# Run by the entrypoint as the `claude` user on first enable. The typescript-language-server
# binary is baked into the image, so this only turns the Claude Code plugin on.
set -uo pipefail
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install typescript-lsp@claude-plugins-official --scope user

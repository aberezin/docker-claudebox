#!/usr/bin/env bash
# summary: enable the gopls-lsp Claude plugin (gopls server baked into the image)
# Run by the entrypoint as the `claude` user on first enable. Idempotent — the
# entrypoint marker-guards this so it only runs once per project.
set -uo pipefail
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install gopls-lsp@claude-plugins-official --scope user

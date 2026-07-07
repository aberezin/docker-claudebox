#!/bin/bash
# init.d hook — install the TypeScript LSP plugin for this project.
#
# This is a Node + TypeScript project, so the TypeScript language-server plugin gives
# claudebot real code intelligence (go-to-definition, diagnostics, safe refactors)
# while it works. The plugin ships NO binary — it needs `typescript-language-server` on
# PATH; the full image bakes that (and `typescript`) so this hook only has to turn the
# plugin on. init.d hooks run ONCE on first container create, as root — so we
# drop to the `claude` user to install into the mounted per-project ~/.claude with the
# right ownership. Best-effort: if the marketplace can't be reached, the build still
# proceeds. See docs/customization.md (Init hooks + Plugins).
setpriv --reuid="$(id -u claude)" --regid="$(id -g claude)" --init-groups \
  bash -c '
    export HOME=/home/claude CLAUDE_CONFIG_DIR=/home/claude/.claude PATH=/home/claude/.local/bin:$PATH
    claude plugin marketplace add anthropics/claude-plugins-official &&
    claude plugin install typescript-lsp@claude-plugins-official --scope user
  ' || echo "init.d: typescript-lsp plugin not installed (offline?) — continuing"

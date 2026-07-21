#!/usr/bin/env bash
# End-to-end example: bootstrap a claudebot project, then have claudebot build AND
# run a small todo web app fully autonomously — reachable from your Mac's browser.
#
# This exercises the whole stack: `dridock bootstrap` (intent handoff) -> a
# dedicated per-project Colima VM with a reachable IP -> a per-project TypeScript LSP
# plugin (via an init.d hook) -> claudebot building the app -> docker-out-of-docker
# orchestration (it runs the app as a published sibling container) -> the workload
# reachable from the host.
#
# Prereqs:
#   - `dridock` installed on PATH (install.sh, or: install -m755 wrapper.sh ~/.local/bin/dridock; legacy claudebox symlink also works)
#   - the image built locally (make build-minimal); this script uses the minimal image
#   - auth: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN exported
#
# Usage:  ./run.sh [project-dir]      (default: /tmp/todo-app)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="${1:-/tmp/todo-app}"

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN first" >&2; exit 1
fi
command -v dridock >/dev/null 2>&1 || command -v claudebox >/dev/null 2>&1 || { echo "dridock (or legacy claudebox) not on PATH — install it first (see README)" >&2; exit 1; }
CB_BIN="$(command -v dridock 2>/dev/null || command -v claudebox)"

export DRIDOCK_MINIMAL=1   # only the minimal image is built by `make build-minimal`

echo "==> bootstrapping project at $PROJ"
mkdir -p "$PROJ" && cd "$PROJ"
dridock bootstrap --no-start --force --brief-file "$HERE/BRIEF.md"

# Install the TypeScript LSP plugin for this project via an init.d hook. The hook
# runs once when claudebot's container is first created (during the build below), so
# claudebot has TS code intelligence while it works. It's per-project — it lands in
# this project's own ~/.claude, not globally.
echo "==> adding the TypeScript LSP plugin (init.d hook)"
HOOK_DIR="$("$CB_BIN" claude-dir)/init.d"
mkdir -p "$HOOK_DIR"
install -m 755 "$HERE/init.d/10-typescript-lsp.sh" "$HOOK_DIR/10-typescript-lsp.sh"

echo ""
echo "==> driving claudebot to build + run the app (autonomous, no prompts)…"
"$CB_BIN" -p "Read .dridock/BRIEF.md in full and execute it end-to-end, fully autonomously — build the TODO app and leave the todo-app container running and reachable on port 3000 exactly as the brief specifies. Do not ask any questions. Print a line starting with DONE: when the container is up."

# figure out where to reach it
id="$(awk '/^id:/{print $2}' "$PROJ/.dridock/config.yml")"
ip="$(colima list 2>/dev/null | awk -v p="cb-$id" '$1==p{print $NF}')"

echo ""
echo "======================================================================"
echo "todo app should now be live:"
[ -n "${ip:-}" ] && echo "  open   http://$ip:3000        (this project's VM IP — collision-free)"
echo "  or     http://localhost:3000   (colima-forwarded fallback)"
echo ""
echo "talk to claudebot:  cd $PROJ && DRIDOCK_MINIMAL=1 dridock"
echo "tear down:          cd $PROJ && dridock destroy   (removes the project VM + workload)"
echo "======================================================================"

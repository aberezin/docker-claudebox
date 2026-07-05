#!/usr/bin/env bash
# End-to-end example: bootstrap a claudebot project, then have claudebot build AND
# run a small todo web app fully autonomously — reachable from your Mac's browser.
#
# This exercises the whole fork: `claudebox bootstrap` (intent handoff) -> a
# dedicated per-project Colima VM with a reachable IP -> claudebot building the app
# -> docker-out-of-docker orchestration (it runs the app as a published sibling
# container) -> the workload reachable from the host.
#
# Prereqs:
#   - `claudebox` installed on PATH (install.sh, or: install -m755 wrapper.sh ~/.local/bin/claudebox)
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
command -v claudebox >/dev/null 2>&1 || { echo "claudebox not on PATH — install it first (see README)" >&2; exit 1; }

export CLAUDEBOX_MINIMAL=1   # only the minimal image is built by `make build-minimal`

echo "==> bootstrapping project at $PROJ"
mkdir -p "$PROJ" && cd "$PROJ"
claudebox bootstrap --no-start --force --brief-file "$HERE/BRIEF.md"

echo ""
echo "==> driving claudebot to build + run the app (autonomous, no prompts)…"
claudebox -p "Read .claudebox/BRIEF.md in full and execute it end-to-end, fully autonomously — build the TODO app and leave the todo-app container running and reachable on port 3000 exactly as the brief specifies. Do not ask any questions. Print a line starting with DONE: when the container is up."

# figure out where to reach it
id="$(awk '/^id:/{print $2}' "$PROJ/.claudebox/config.yml")"
ip="$(colima list 2>/dev/null | awk -v p="cb-$id" '$1==p{print $NF}')"

echo ""
echo "======================================================================"
echo "todo app should now be live:"
[ -n "${ip:-}" ] && echo "  open   http://$ip:3000        (this project's VM IP — collision-free)"
echo "  or     http://localhost:3000   (colima-forwarded fallback)"
echo ""
echo "talk to claudebot:  cd $PROJ && CLAUDEBOX_MINIMAL=1 claudebox"
echo "tear down:          cd $PROJ && claudebox destroy   (removes the project VM + workload)"
echo "======================================================================"

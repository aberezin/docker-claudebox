#!/usr/bin/env bash
# summary: verify the modeguard pre-commit hook is in the workspace (not just marked)
# Run by the entrypoint when the feature's marker exists (#75, #124). Exit 0 =
# present, non-zero = reinstall via on.sh.
#
# on.sh exits 0 when the workspace isn't a git repo yet, so the marker gets
# written with no hook installed. Before this check existed the feature then
# stayed "installed" forever, even after `git init`. So:
#   - no .git/hooks       → pass (nothing to guard yet; on.sh would only defer)
#   - .git/hooks, no hook → fail, so on.sh installs it now that git exists
#   - hook lacks marker   → fail, so on.sh reports the foreign hook again
#   - hook has marker     → pass
#   - DRIDOCK_WORKSPACE unset or not a dir → fail, loudly: a check that can't
#     find the workspace must not report "installed"
set -uo pipefail
WS="${DRIDOCK_WORKSPACE:-}"
if [ -z "$WS" ] || [ ! -d "$WS" ]; then
    echo "modeguard check: DRIDOCK_WORKSPACE is '${WS}', not a directory — can't verify the hook" >&2
    exit 1
fi
[ -d "$WS/.git/hooks" ] || exit 0
grep -qF "# dridock-modeguard" "$WS/.git/hooks/pre-commit" 2>/dev/null

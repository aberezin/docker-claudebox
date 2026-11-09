#!/usr/bin/env bash
# SessionStart hook: say so when this clone's git hooks are missing, stale, or
# shadowed by core.hooksPath.
#
# WHY (#104). The pre-commit guard that refuses direct commits on master is
# installed by a once-per-clone `make hooks`, and nothing noticed when that never
# happened: on 2026-11-09, two months after CLAUDE.md started requiring the step,
# the checkout at `~aberezin/.../docker-out-of-docker/docker-claudebox` on this
# host held only `.git/hooks/*.sample` — so the guard this repo documents as
# ENFORCED was absent from a live checkout of it.
# Staleness is the quieter half: `.githooks/pre-commit` has changed twice
# (CHANGELOG.md:65, then 99633cf) and a clone can hold an installed, passing
# guard that prints advice the repo has since retracted.
#
# NOT auto-installed here. A SessionStart hook silently writing into .git/hooks
# is a side effect nobody asked for; `.githooks/install.sh` stays the thing you
# run. This only tells you to run it, and names the literal command.
#
# Silent + rc 0 when everything is current, so it adds no context noise on
# resume/compact. All the detection lives in .githooks/install.sh --check —
# this is only the relay, so the two surfaces cannot drift.
set -u

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CHECK="$REPO/.githooks/install.sh"

# Not the dridock harness repo (or an old checkout that predates the installer)
# → nothing to say. This hook is project-scoped, so that is a clean no-op.
[ -f "$CHECK" ] || exit 0

_out="$(bash "$CHECK" --check 2>&1)"
_rc=$?
[ "$_rc" -eq 0 ] && exit 0

echo "[dridock git hooks] this clone's hooks are not in the state the repo expects:"
printf '%s\n' "$_out" | sed 's/^/  • /'
echo "  Fix it with ONE command, from $REPO:"
echo "      make hooks"
echo "  (that installs every hook in .githooks/ — see #104. The pre-commit one"
echo "   refuses direct commits on master, which CLAUDE.md requires.)"
exit 0

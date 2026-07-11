#!/usr/bin/env bash
# SessionStart hook (framework-Claude side): surface pending framework consults and, if no
# watcher is running, nudge this session to launch `claudebox consult watch` as a background
# task. Idempotent — stays silent when there's nothing pending AND a watcher already runs, so
# it doesn't nag or double-spawn on resume/compact. Output goes to stdout → session context.
# See docs/design/framework-consult.md ("Staying alerted"). Repo-local; no image dependency.
set -u

command -v claudebox >/dev/null 2>&1 || exit 0   # not this machine / wrapper not installed

CH="${XDG_CONFIG_HOME:-$HOME/.config}/claudebox/consult"
[ -d "$CH" ] || exit 0

draft=0; appr=0; dids=""
for td in "$CH"/*/; do
    [ -d "$td" ] || continue; td="${td%/}"; m="$td/meta"; [ -f "$m" ] || continue
    case "$(sed -n 's/^status=//p' "$m" | tail -1)" in
        awaiting-framework) draft=$((draft + 1)); dids="${dids:+$dids, }$(basename "$td")" ;;
        awaiting-approval)  appr=$((appr + 1)) ;;
    esac
done

watching=no
ps -Ao command 2>/dev/null | grep -q 'consult watch' && watching=yes

# Nothing to do — no pending work and already watching → stay silent (no context noise).
[ "$draft" = 0 ] && [ "$appr" = 0 ] && [ "$watching" = yes ] && exit 0

echo "[claudebox framework-consult] status at session start:"
[ "$draft" -gt 0 ] && echo "  • ${draft} consult(s) awaiting a framework DRAFT (${dids}) — work them via the framework-consult skill."
[ "$appr" -gt 0 ] && echo "  • ${appr} consult(s) awaiting the human's approval (no action from you until they approve)."
if [ "$watching" = yes ]; then
    echo "  • a consult watcher is already running — you'll be re-invoked when a thread changes."
else
    echo "  • NO watcher running. To be alerted to incoming consults/replies this session, launch"
    echo "    \`claudebox consult watch\` as a BACKGROUND task now (run_in_background: true), and"
    echo "    RELAUNCH it each time it fires (it exits on the first change — that's the loop)."
fi
exit 0

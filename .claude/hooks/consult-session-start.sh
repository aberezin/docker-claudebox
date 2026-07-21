#!/usr/bin/env bash
# SessionStart hook (framework-Claude side): surface pending framework consults and, if no
# watcher is running, nudge this session to launch the watcher as a background task.
# Works in BOTH environments where framework-Claude runs:
#   - Mac / host: verb is `dridock consult watch` (or legacy `claudebox consult watch`),
#     consult dir is under ~/.config/dridock/consult (or legacy ~/.config/claudebox/consult).
#   - Framework-dev claudebot / in-container: verb is `cb-harness-watch-consults`, consult
#     dir is under $DRIDOCK_CONSULT_DIR (typically /home/claude/framework-consult).
# Pre-3.2.1 this hook was Mac-only (grepped for `claudebox` binary and looked at
# ~/.config/claudebox/consult), so it silently exited in the container even when a
# consult was pending — no nudge, no watcher, missed events. See #16 / #17 follow-up.
# Idempotent — stays silent when nothing is pending AND a watcher already runs, so
# doesn't nag or double-spawn on resume/compact. See docs/design/framework-consult.md.
set -u

# Detect environment and resolve (a) the consult dir, (b) the watcher verb to nudge.
if [ -f /.dockerenv ]; then
    CH="${DRIDOCK_CONSULT_DIR:-${CLAUDEBOX_CONSULT_DIR:-/home/claude/framework-consult}}"
    WATCHER='cb-harness-watch-consults'
    WATCHER_LAUNCH='cb-harness-watch-consults'
    WATCHER_PS_PATTERN='cb-harness-watch-consults'
else
    # Host: skip silently if the wrapper isn't on PATH (either name — 3.0+ ships `dridock`,
    # 2.x is `claudebox`; the wrapper's install.sh also symlinks `claudebox`→`dridock`).
    if command -v dridock >/dev/null 2>&1; then
        WATCHER='dridock consult watch'
        WATCHER_LAUNCH='dridock consult watch'
    elif command -v claudebox >/dev/null 2>&1; then
        WATCHER='claudebox consult watch'
        WATCHER_LAUNCH='claudebox consult watch'
    else
        exit 0
    fi
    CH="${XDG_CONFIG_HOME:-$HOME/.config}/dridock/consult"
    [ -d "$CH" ] || CH="${XDG_CONFIG_HOME:-$HOME/.config}/claudebox/consult"
    WATCHER_PS_PATTERN='consult watch'
fi

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
ps -Ao command 2>/dev/null | grep -qF "$WATCHER_PS_PATTERN" && watching=yes

# Nothing to do — no pending work and already watching → stay silent (no context noise).
[ "$draft" = 0 ] && [ "$appr" = 0 ] && [ "$watching" = yes ] && exit 0

echo "[dridock framework-consult] status at session start:"
[ "$draft" -gt 0 ] && echo "  • ${draft} consult(s) awaiting a framework DRAFT (${dids}) — work them via the framework-consult skill."
[ "$appr" -gt 0 ] && echo "  • ${appr} consult(s) awaiting the human's approval (no action from you until they approve)."
if [ "$watching" = yes ]; then
    echo "  • a consult watcher (${WATCHER}) is already running — you'll be re-invoked when a thread changes."
else
    echo "  • NO watcher running. To be alerted to incoming consults/replies this session, launch"
    echo "    \`${WATCHER_LAUNCH}\` as a BACKGROUND task now (run_in_background: true), and"
    echo "    RELAUNCH it each time it fires (it exits on the first change — that's the loop)."
fi
exit 0

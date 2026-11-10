# shellcheck shell=bash
# Sourced, not executed. The ONE definition of "is a live watch consuming
# this agent's team inbox" (#105).
#
# Two callers read this: the UserPromptSubmit hook (decides whether to drain
# in-line, nag, or advance the cursor over a Monitor's range — #56/#102) and
# the status line (shows 📬 live / off). They must agree; a status line that
# says "live" while the hook nags "NOT armed" is a third copy of one fact,
# the drift class #101 closed. So the check lives here and both source it.
#
# Usage:
#   . "$dir/lib/team-inbox-watch.sh"
#   twh_find_tail "$inbox"     # sets TWH_TAIL_PID and TWH_TAIL_ARM
#
# TWH_TAIL_PID — pid of a process whose cmdline is a `tail -F` on $inbox,
#                or empty when nothing is watching.
# TWH_TAIL_ARM — the byte offset that tail was armed at (`-c +N` → N), or
#                empty when it can't be read. #102 uses it to know which
#                range the watch is responsible for delivering.
#
# This settles WHETHER a watch is live, not WHICH inbox. Callers resolve the
# agent independently — the hook via `dridock team whoami`, the status line via
# $DRIDOCK_AGENT_NAME with whoami as fallback — but they can't name different
# agents: whoami honours the env var itself and rejects a name not in the
# roster, so a bad value makes the hook exit and the status line go silent
# together.

# Outputs are read by the sourcing caller, not here.
# shellcheck disable=SC2034
twh_find_tail() {
    TWH_TAIL_PID=""
    TWH_TAIL_ARM=""
    local _inbox="$1" _p _cmd
    command -v pgrep >/dev/null 2>&1 || return 0
    # pgrep narrows by the fixed string, then the cmdline is filtered with a
    # glob, so the `.` in `.jsonl` isn't a regex wildcard (Arfy's nit #2, #56).
    for _p in $(pgrep -f 'tail -F' 2>/dev/null || true); do
        # The process must actually BE a tail. Until #105's review this also
        # accepted any process whose cmdline merely MENTIONED the arm command —
        # a `bash -c` wrapper (deliberately), but equally a diagnostic `pgrep`
        # or anything quoting a printed arm line. Arfy reproduced a non-tail
        # decoy reading as live. That's a false "📬 live" for a human, and for
        # the hook it's silent loss: a decoy quoting a STALE, lower offset takes
        # #102's no-gap path and advances the cursor past events nobody saw.
        # The real tail always exists alongside its wrapper (it's the wrapper's
        # child; the wrapper exits when it does) — checked on macOS and
        # in-container — so requiring comm == tail loses nothing. `${##*/}`
        # because comm can carry a path on BSD.
        _comm="$(ps -p "$_p" -o comm= 2>/dev/null | tr -d ' ')"
        case "${_comm##*/}" in tail) ;; *) continue ;; esac
        _cmd="$(ps -p "$_p" -o command= 2>/dev/null || true)"
        case "$_cmd" in
            *"$_inbox"*)
                TWH_TAIL_PID="$_p"
                TWH_TAIL_ARM="$(printf '%s' "$_cmd" | sed -n 's/.*-c +\([0-9][0-9]*\).*/\1/p' | head -1)"
                return 0
                ;;
        esac
    done
    return 0
}

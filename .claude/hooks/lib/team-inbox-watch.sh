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
        _cmd="$(ps -p "$_p" -o command= 2>/dev/null || true)"
        case "$_cmd" in
            *"$_inbox"*)
                TWH_TAIL_PID="$_p"
                # Also matches the `bash -c` wrapper around the tail, whose
                # cmdline embeds the same string — either is fine.
                TWH_TAIL_ARM="$(printf '%s' "$_cmd" | sed -n 's/.*-c +\([0-9][0-9]*\).*/\1/p' | head -1)"
                return 0
                ;;
        esac
    done
    return 0
}

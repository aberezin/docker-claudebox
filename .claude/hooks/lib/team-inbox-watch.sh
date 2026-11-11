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
#   twh_socket_live "$inbox" "$session_id"   # sets TWH_SOCKET_LIVE (1 or "")
#   twh_inbound_in_force       # sets TWH_INBOUND and TWH_INBOUND_SRC (#107)
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
    local _inbox="$1" _p _cmd _comm
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

# ─── socket delivery (#107) ──────────────────────────────────────────────
# The fetcher can post each event straight into the session's inbox socket
# ($CLAUDE_CODE_MESSAGING_SOCKET) instead of the agent keeping a Monitor
# armed. It is only SAFE when Claude Code will deliver the post rather than
# hold it: the socket never acknowledges, so a held message looks delivered
# to the fetcher, which then advances the cursor past it — silent loss. The
# fetcher is detached (reparented to init), so it can't be verified as the
# session's own child; only `crossSessionInbound: "accept"` gets it through.
#
# So the SessionStart hook writes `<inbox>.wake.json` (the fetcher's "post
# here" instruction) ONLY when twh_inbound_in_force says accept, and the
# prompt hook removes it the moment that stops being true.

# Effective crossSessionInbound, from the settings reference's precedence:
# managed → `--settings` flag → user settings; the first value found applies.
# A project or local value applies only if STRICTER — so project/local can
# turn on hold/refuse but never accept (a cloned repo can't open your
# session). An unrecognized value in flag/user/project/local holds; one in
# managed refuses. Args are paths to settings files (missing = unset) except
# the flag, which is the raw `--settings` value: inline JSON or a file path.
# Sets TWH_INBOUND to accept|hold|refuse|unset.
# shellcheck disable=SC2034
twh_effective_inbound() {
    local _managed="$1" _flag="$2" _user="$3" _project="$4" _local="$5"
    local _q='if type == "object" and has("crossSessionInbound") then .crossSessionInbound else empty end'
    local _m="" _f="" _u="" _p="" _l="" _invalid=0 _v _r
    command -v jq >/dev/null 2>&1 || { TWH_INBOUND="unset"; return 0; }
    [ -f "$_managed" ] && _m="$(jq -r "$_q" "$_managed" 2>/dev/null)"
    if [ -n "$_flag" ]; then
        case "$_flag" in
            '{'*) _f="$(printf '%s' "$_flag" | jq -r "$_q" 2>/dev/null)" ;;
            *)    [ -f "$_flag" ] && _f="$(jq -r "$_q" "$_flag" 2>/dev/null)" ;;
        esac
    fi
    [ -f "$_user" ]    && _u="$(jq -r "$_q" "$_user" 2>/dev/null)"
    [ -f "$_project" ] && _p="$(jq -r "$_q" "$_project" 2>/dev/null)"
    [ -f "$_local" ]   && _l="$(jq -r "$_q" "$_local" 2>/dev/null)"
    # Unrecognized managed value → refuse until an administrator fixes it.
    case "$_m" in ""|accept|hold|refuse) ;; *) TWH_INBOUND="refuse"; return 0 ;; esac
    for _v in "$_f" "$_u" "$_p" "$_l"; do
        case "$_v" in ""|accept|hold|refuse) ;; *) _invalid=1 ;; esac
    done
    # First trusted value wins.
    _r="unset"
    for _v in "$_m" "$_f" "$_u"; do
        case "$_v" in accept|hold|refuse) _r="$_v"; break ;; esac
    done
    # Project/local can only make it stricter.
    for _v in "$_p" "$_l"; do
        case "$_v" in
            refuse) _r="refuse" ;;
            hold)   [ "$_r" = "refuse" ] || _r="hold" ;;
        esac
    done
    # Any unrecognized value holds — unless something already refuses.
    [ "$_invalid" = 1 ] && [ "$_r" != "refuse" ] && _r="hold"
    TWH_INBOUND="$_r"
}

# The `--settings` value Claude Code was launched with, read off the nearest
# ancestor process whose name is `claude`. Empty when there isn't one or it
# has no --settings. /proc on Linux (exact argv); `ps` on macOS, where argv
# is space-joined — fine for the inline JSON dridock passes, which has no
# spaces.
# TWH_ANCESTOR_PID overrides where the walk starts. Tests set it to 1 (= no
# claude ancestor); without it, a test run from inside a Claude session would
# find THAT session's --settings and its result would depend on the runner.
twh_claude_settings_flag() {
    local _pid="${TWH_ANCESTOR_PID:-${PPID:-}}" _i _comm _next="" _a
    TWH_SETTINGS_FLAG=""
    for _i in 1 2 3 4 5 6 7 8; do
        [ -n "$_pid" ] && [ "$_pid" -gt 1 ] 2>/dev/null || return 0
        _comm="$(ps -p "$_pid" -o comm= 2>/dev/null | tr -d ' ')"
        if [ "${_comm##*/}" = "claude" ]; then
            if [ -r "/proc/$_pid/cmdline" ]; then
                while IFS= read -r -d '' _a; do
                    if [ "$_next" = 1 ]; then TWH_SETTINGS_FLAG="$_a"; return 0; fi
                    case "$_a" in
                        --settings)   _next=1 ;;
                        --settings=*) TWH_SETTINGS_FLAG="${_a#--settings=}"; return 0 ;;
                    esac
                done < "/proc/$_pid/cmdline"
            else
                TWH_SETTINGS_FLAG="$(ps -p "$_pid" -o command= 2>/dev/null \
                    | sed -n "s/.*--settings[= ]\([^ ]*\).*/\1/p" | head -1)"
                TWH_SETTINGS_FLAG="${TWH_SETTINGS_FLAG#\'}"
                TWH_SETTINGS_FLAG="${TWH_SETTINGS_FLAG%\'}"
            fi
            return 0
        fi
        _pid="$(ps -p "$_pid" -o ppid= 2>/dev/null | tr -d ' ')"
    done
    return 0
}

# Gather this session's sources and decide. Sets TWH_INBOUND and a short
# TWH_INBOUND_SRC naming where a trusted accept would come from, for the
# hook's one-line explanation.
# shellcheck disable=SC2034
twh_inbound_in_force() {
    local _managed _cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" _proj="${CLAUDE_PROJECT_DIR:-$PWD}"
    if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
        _managed="/Library/Application Support/ClaudeCode/managed-settings.json"
    else
        _managed="/etc/claude-code/managed-settings.json"
    fi
    twh_claude_settings_flag
    twh_effective_inbound "$_managed" "$TWH_SETTINGS_FLAG" "$_cfg/settings.json" \
        "$_proj/.claude/settings.json" "$_proj/.claude/settings.local.json"
    if [ -n "$TWH_SETTINGS_FLAG" ]; then TWH_INBOUND_SRC="--settings flag"; else TWH_INBOUND_SRC="settings files"; fi
}

# Is socket delivery live for THIS session? True when the wake file names
# this session and its socket still exists. The status line and the prompt
# hook both call this, so "📬 live" and "no Monitor nag" mean the same thing.
# shellcheck disable=SC2034
twh_socket_live() {
    local _wake="$1.wake.json" _sid="$2" _ws _wsid
    TWH_SOCKET_LIVE=""
    [ -n "$_sid" ] && [ -f "$_wake" ] && command -v jq >/dev/null 2>&1 || return 0
    _wsid="$(jq -r '.sessionId // empty' "$_wake" 2>/dev/null)"
    _ws="$(jq -r '.socket // empty' "$_wake" 2>/dev/null)"
    [ "$_wsid" = "$_sid" ] && [ -S "$_ws" ] && TWH_SOCKET_LIVE=1
    return 0
}

# Write the wake file (chmod 600: it carries the session token).
twh_write_wake() {
    local _inbox="$1" _sid="$2" _tmp
    [ -n "$_sid" ] && [ -n "${CLAUDE_CODE_MESSAGING_SOCKET:-}" ] && command -v jq >/dev/null 2>&1 || return 1
    _tmp="$(umask 077; mktemp "$_inbox.wake.XXXXXX")" || return 1
    if jq -n --arg s "$CLAUDE_CODE_MESSAGING_SOCKET" --arg t "${CLAUDE_CODE_MESSAGING_TOKEN:-}" \
          --arg id "$_sid" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{socket: $s, sessionId: $id, writtenAt: $at} + (if $t == "" then {} else {token: $t} end)' > "$_tmp"; then
        chmod 600 "$_tmp" && mv "$_tmp" "$_inbox.wake.json"
    else
        rm -f "$_tmp"; return 1
    fi
}

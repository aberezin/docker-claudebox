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
    # Managed = managed-settings.json PLUS any managed-settings.d/*.json
    # drop-ins beside it (Arfy, #107 review). Take the STRICTEST value across
    # all of them — fail-safe: a policy hold/refuse in a drop-in must never be
    # outvoted by how we guess the merge order. Unrecognized → refuse (below).
    local _mf _mv _md
    _md="$(dirname "$_managed")/managed-settings.d"
    for _mf in "$_managed" "$_md"/*.json; do
        [ -f "$_mf" ] || continue
        _mv="$(jq -r "$_q" "$_mf" 2>/dev/null)"
        case "$_mv" in
            "")     ;;                                    # not set in this file
            refuse) [ "$_m" = invalid ] || _m="refuse" ;;
            hold)   case "$_m" in refuse|invalid) ;; *) _m="hold" ;; esac ;;
            accept) [ -n "$_m" ] || _m="accept" ;;
            *)      _m="invalid" ;;                       # → refuse below
        esac
    done
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
# has no --settings.
#
# LOAD-BEARING: only from /proc/<pid>/cmdline, where argv is NUL-separated
# and exact. NOT from `ps -o command=` (macOS): that joins argv with spaces
# and drops the quoting, so a `--settings '{…accept…}'` that merely appears
# INSIDE another argument — the --append-system-prompt text, which carries
# CLAUDE.md, always-skills and this feature's own docs — is indistinguishable
# from a real flag. Arfy measured that as a false `accept` (#107 review): wake
# file written, every post held, cursor advanced — silent loss. So off /proc
# the flag source is skipped and the decision rests on managed + user
# settings. dridock passes the flag in Linux containers, where /proc exists.
# tests/test_team_socket_delivery.sh pins both halves.
#
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
            [ -r "/proc/$_pid/cmdline" ] || return 0   # no exact argv → no flag source (see above)
            while IFS= read -r -d '' _a; do
                if [ "$_next" = 1 ]; then TWH_SETTINGS_FLAG="$_a"; return 0; fi
                case "$_a" in
                    --settings)   _next=1 ;;
                    --settings=*) TWH_SETTINGS_FLAG="${_a#--settings=}"; return 0 ;;
                esac
            done < "/proc/$_pid/cmdline"
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

# ─── can the RUNNING fetcher post? (#107 review) ─────────────────────────
# The hooks come from the repo; the fetcher is whatever binary was running
# when it was spawned. A pre-5.14 fetcher never posts, so a wake file in front
# of it means `📬 live·sock` and a silenced "Monitor NOT armed" nag while
# delivery is really prompt-only — a worse diagnostic than having no socket
# delivery at all.
#
# The version must be the RUNNING fetcher's, not the binary on PATH: on the
# host the fetcher is long-lived, so after ./install.sh PATH says 5.14 while
# the old fetcher is still the one that would have to post (Arfy, #107 — the
# diagnostics-from-current-run rule). Sources, most exact first:
#   1. /proc/<pid>/exe --version — the running process's own binary (the
#      inode it was started from, even if the file was since replaced). Linux.
#      Also covers the harness repo's own container, where the hooks come from
#      the workspace checkout and the fetcher from the image, so skew is real.
#   2. <inbox>.version — the stamp UPS/SessionStart write right after a spawn
#      is CONFIRMED (host).
# Neither available → fail OPEN (unknown is not "too old"): refusing would
# turn socket delivery off wherever the version just can't be read.
#
# LOAD-BEARING: TWH_SOCKET_MIN_FETCHER is the first release whose fetcher
# posts (SessionWaker.ts). Lowering it re-opens the false live·sock.
TWH_SOCKET_MIN_FETCHER="5.14.0"

# Sets TWH_FETCHER_VER (may be empty) and TWH_FETCHER_VER_SRC.
# shellcheck disable=SC2034
twh_fetcher_version() {
    local _inbox="$1" _pid
    TWH_FETCHER_VER=""; TWH_FETCHER_VER_SRC=""
    _pid="$(cat "$_inbox.pid" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$_pid" ] && [ -x "/proc/$_pid/exe" ] 2>/dev/null; then
        TWH_FETCHER_VER="$("/proc/$_pid/exe" --version 2>/dev/null | awk 'NR==1{print $NF}')"
        case "$TWH_FETCHER_VER" in [0-9]*.[0-9]*.[0-9]*) TWH_FETCHER_VER_SRC="running fetcher pid $_pid"; return 0 ;; esac
        TWH_FETCHER_VER=""
    fi
    TWH_FETCHER_VER="$(tr -d '[:space:]' < "$_inbox.version" 2>/dev/null)"
    case "$TWH_FETCHER_VER" in
        [0-9]*.[0-9]*.[0-9]*) TWH_FETCHER_VER_SRC="$_inbox.version" ;;
        *) TWH_FETCHER_VER="" ;;
    esac
    return 0
}

# Returns 1 ONLY when the running fetcher's version is known and below the
# minimum; sets TWH_FETCHER_TOO_OLD_MSG for the caller to print.
# shellcheck disable=SC2034
twh_fetcher_can_post() {
    TWH_FETCHER_TOO_OLD_MSG=""
    twh_fetcher_version "$1"
    [ -n "$TWH_FETCHER_VER" ] || return 0
    [ "$(printf '%s\n%s\n' "$TWH_SOCKET_MIN_FETCHER" "$TWH_FETCHER_VER" | sort -V | head -1)" = "$TWH_SOCKET_MIN_FETCHER" ] && return 0
    if [ -f /.dockerenv ]; then
        TWH_FETCHER_TOO_OLD_MSG="the fetcher is running $TWH_FETCHER_VER (from $TWH_FETCHER_VER_SRC); socket delivery needs $TWH_SOCKET_MIN_FETCHER — it comes with the image, so on the Mac: make build, then dridock down + dridock start"
    else
        TWH_FETCHER_TOO_OLD_MSG="the fetcher is running $TWH_FETCHER_VER (from $TWH_FETCHER_VER_SRC); socket delivery needs $TWH_SOCKET_MIN_FETCHER — after ./install.sh it restarts on the next prompt and this turns on by itself"
    fi
    return 1
}

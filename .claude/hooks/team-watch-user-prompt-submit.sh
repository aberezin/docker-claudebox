#!/usr/bin/env bash
# UserPromptSubmit hook (team-watch, spec #56): the self-healing check
# that makes team-bus delivery loud when it degrades mid-session.
#
# Runs on every user prompt. Fires only when something is wrong — most
# invocations produce no output (see spec #56's "loud on failure,
# silent on health").
#
# Two checks, both cheap:
#   1. FETCHER liveness  — the detached `dridock team watch --inbox`
#      process the SessionStart hook spawned. If dead + backoff window
#      expired, respawn and surface the last log line so an
#      immediate-crash loop is diagnosable (spec #56 open loop #5).
#   2. CONSUMER liveness — the Monitor-driven `tail -F` process that
#      streams new inbox lines into this Claude session. If inbox has
#      grown past the session's last drain offset AND no tail is
#      consuming the file, print the delta events in-line and re-print
#      the arm command with the fresh offset. The "landed but nobody
#      read it" case that opened #56.
#
# Backoff: 60s minimum between respawn attempts. A wedged fetcher that
# crashes at boot would otherwise consume one spawn per user turn.
#
# Version gate: `--inbox` is 4.2.0+. If the installed binary predates it,
# skip loudly rather than crash-loop the fetcher every turn (Arfy's
# related-#1 finding on #56 — a branch checkout without `./install.sh`
# arms hooks against an incompatible binary).
set -u

# Silent no-op guards.
command -v dridock >/dev/null 2>&1 || exit 0
dridock team roster >/dev/null 2>&1 || exit 0
_self="$(dridock team whoami 2>/dev/null | head -1 || true)"
[ -n "$_self" ] || exit 0

# Version gate — 4.2.0+ has `dridock team fetcher`. Older binaries
# return "unknown subcommand 'fetcher'". One-line probe.
if dridock team fetcher status --inbox /dev/null 2>&1 | grep -q "unknown subcommand"; then
    echo "⚠ team-watch: installed dridock binary predates 4.2.0 (missing 'fetcher' verb) — skipping this hook."
    echo "  Fix: on the host, git pull + ./install.sh; in-container, make build + dridock down + dridock start."
    exit 0
fi

# Session id from stdin payload (UserPromptSubmit shape includes it).
_payload="$(cat 2>/dev/null || echo '')"
_session_id=""
if [ -n "$_payload" ] && command -v jq >/dev/null 2>&1; then
    _session_id="$(printf '%s' "$_payload" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

# Convention paths.
_xdg="${XDG_CONFIG_HOME:-$HOME/.config}"
_inbox="$_xdg/dridock/inbox/$_self.jsonl"
_pid="$_inbox.pid"
_log="$_inbox.log"
_cursors="$_inbox.session-cursors.json"
_respawn_stamp="$_inbox.respawn-stamp"

# Ensure the inbox dir exists BEFORE any operation that would write into
# it. Missing when SessionStart hasn't yet run (or was skipped) —
# nohup's `>>$_log` redirect fails silently otherwise, killing the
# spawn AND the diagnostic channel. (Arfy's blocking finding #3.)
mkdir -p "$(dirname "$_inbox")"

# ── Check 1: fetcher liveness (kill -0 + ps cmdline match) ───────────
# Two-part liveness per spec #56 open loop #4 — the ps cmdline check is
# what prevents a pid-reuse false positive after reboot/wraparound.
_check_fetcher_alive() {
    local pid="$1"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    ps -p "$pid" -o command= 2>/dev/null | grep -qF "dridock team watch" || return 1
    ps -p "$pid" -o command= 2>/dev/null | grep -qF "$_inbox" || return 1
    return 0
}

_fetcher_alive=0
if [ -f "$_pid" ]; then
    _pidval="$(cat "$_pid" 2>/dev/null || true)"
    if _check_fetcher_alive "$_pidval"; then
        _fetcher_alive=1
    fi
fi

if [ "$_fetcher_alive" = 0 ]; then
    # Respawn backoff: skip if we tried within the last 60s.
    _now=$(date +%s)
    _last_attempt=0
    [ -f "$_respawn_stamp" ] && _last_attempt=$(cat "$_respawn_stamp" 2>/dev/null || echo 0)
    if [ $((_now - _last_attempt)) -lt 60 ]; then
        echo "⚠ team fetcher: still not alive (backoff active — last attempt $((_now - _last_attempt))s ago; will retry in $((60 - _now + _last_attempt))s). See $_log."
    else
        # Surface last log line for diagnosis + respawn + VERIFY the spawn.
        if [ -f "$_log" ]; then
            _last_log="$(tail -n 1 "$_log" 2>/dev/null || true)"
            [ -n "$_last_log" ] && echo "⚠ team fetcher: gone — last log line: $_last_log"
        fi
        rm -f "$_pid"
        ( nohup dridock team watch --inbox "$_inbox" >>"$_log" 2>&1 & disown ) >/dev/null 2>&1 || true
        echo "$_now" > "$_respawn_stamp"

        # Verify (Arfy's nit #1): the subshell + & always returns 0,
        # so we need to check pidfile + cmdline before claiming success.
        sleep 1
        _spawn_pid="$(cat "$_pid" 2>/dev/null || true)"
        if _check_fetcher_alive "$_spawn_pid"; then
            echo "🚀 team fetcher: respawned (pid=$_spawn_pid, log=$_log)."
        else
            echo "⚠ team fetcher: respawn attempted but pid not alive OR cmdline mismatch."
            if [ -f "$_log" ]; then
                _tail_log="$(tail -n 3 "$_log" 2>/dev/null || true)"
                if [ -n "$_tail_log" ]; then
                    echo "  Last log lines:"
                    printf '%s\n' "$_tail_log" | sed 's/^/    /'
                fi
            fi
            echo "  log=$_log"
        fi
    fi
fi

# ── Check 2: consumer liveness ───────────────────────────────────────
# Only meaningful if the inbox actually exists and has content.
[ -f "$_inbox" ] || exit 0
_inbox_size=$(stat -c %s "$_inbox" 2>/dev/null || stat -f %z "$_inbox" 2>/dev/null || echo 0)

# What did we drain up to for this session?
# Default to CURRENT EOF (matches SessionStart's fallback) so an unknown/
# missing session_id can NEVER cause a full-inbox replay every turn
# (Arfy's blocking finding #2, spec #56 open loop #3).
_last_offset="$_inbox_size"
if [ -n "$_session_id" ] && [ -f "$_cursors" ] && command -v jq >/dev/null 2>&1; then
    _v="$(jq -r --arg id "$_session_id" '.[$id] // empty' "$_cursors" 2>/dev/null || true)"
    if [ -n "$_v" ] && [ "$_v" != "null" ]; then _last_offset="$_v"; fi
fi

# Is a tail process consuming this inbox file? Use pgrep-narrow-then-ps-filter
# so the `.` in `.jsonl` isn't treated as a regex wildcard (Arfy's nit #2).
#
# Checked BEFORE the nothing-new early exit (#56). It used to sit after, so the
# channel's health was only ever examined when there was already undelivered
# mail — meaning a dead channel with no traffic was indistinguishable from a
# healthy idle one, and the reminder was missing at the exact moment it mattered
# most: a freshly-started session, before anything had arrived.
#
# Observed: Bear came up on a fresh container and did not arm his Monitor. His
# inbox was empty, so no nag fired; he stayed dark until Alan prompted him. And
# because he had been told to wait, no prompt was coming — so the fallback that
# is supposed to cover an unarmed Monitor could never trigger. Same shape as
# `surfaced: 0` before the `skipped` counter: silence meaning two different
# things.
_tail_pid=""
if command -v pgrep >/dev/null 2>&1; then
    for _p in $(pgrep -f 'tail -F' 2>/dev/null || true); do
        if ps -p "$_p" -o command= 2>/dev/null | grep -qF "$_inbox"; then
            _tail_pid="$_p"
            break
        fi
    done
fi

# Nothing new to deliver. Still report an unarmed Monitor — the live layer is
# down whether or not mail happens to be waiting, and saying so only when there
# is a backlog means you learn about it after it has already cost you.
if [ "$_inbox_size" -le "$_last_offset" ]; then
    if [ -z "$_tail_pid" ]; then
        echo ""
        echo "📬 team-inbox: your Monitor is NOT armed — live delivery is off. Events will"
        echo "   only reach you at the next SessionStart or prompt. Arm it (persistent):"
        echo "       tail -F -c +$((_inbox_size + 1)) $_inbox"
    fi
    exit 0
fi

if [ -n "$_tail_pid" ]; then
    # Tail is running — Monitor is consuming. The stale drain offset
    # just hasn't been updated yet (SessionStart is where updates
    # happen). Nothing to surface.
    exit 0
fi

# Tail NOT running → Monitor isn't armed (or died). Surface delta
# events in-line so they aren't silently swallowed, then re-print the
# arm command with the fresh offset for Claude to re-arm.
_delta=$((_inbox_size - _last_offset))
echo ""
echo "─── team-inbox: $_delta unread bytes since offset $_last_offset (Monitor not armed) ───"
tail -c "+$((_last_offset + 1))" "$_inbox" | head -c "$_delta"
echo "─── end delta ───"
echo ""
echo "📬 team-inbox: re-arm your Monitor with (persistent):"
echo "    tail -F -c +$((_inbox_size + 1)) $_inbox"

# Update cursor to current EOF so we don't re-surface these on the next
# turn. Requires session_id — with no session_id, cursor can't advance
# and the delta will re-surface next turn. That's the correct behavior:
# it's loud (surfaces every turn) rather than silent (misses events),
# and it stops as soon as SessionStart runs with a session_id (which
# writes cursor and unwedges).
if [ -n "$_session_id" ] && command -v jq >/dev/null 2>&1; then
    if [ ! -f "$_cursors" ]; then echo '{}' > "$_cursors"; fi
    _tmp="$(mktemp)"
    if jq --arg id "$_session_id" --argjson off "$_inbox_size" '. + {($id): $off}' "$_cursors" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$_cursors"
    else
        rm -f "$_tmp"
    fi
fi

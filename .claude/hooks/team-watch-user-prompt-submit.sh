#!/usr/bin/env bash
# UserPromptSubmit hook (team-watch, spec #56): the self-healing check
# that makes team-bus delivery loud when it degrades mid-session.
#
# Runs on every user prompt. Fires only when something is wrong — most
# invocations produce no output (see spec #56's "loud on failure, silent
# on health").
#
# Two checks, both cheap:
#   1. FETCHER liveness  — the detached `dridock team watch --inbox`
#      process the SessionStart hook spawned. If dead + backoff window
#      expired, respawn and surface the last log line so an
#      immediate-crash loop is diagnosable (per spec #56 open loop #5).
#   2. CONSUMER liveness — the Monitor-driven `tail -F` process that
#      streams new inbox lines into this Claude session. If inbox has
#      grown past the session's last drain offset AND no tail is
#      consuming the file, print the delta events in-line and re-print
#      the arm command. The message "landed but nobody's reading" is
#      exactly the silent-degrade case that opened #56.
#
# Backoff: 60s minimum between respawn attempts. A wedged fetcher that
# crashes at boot would otherwise consume one spawn per user turn.
set -u

# Silent no-op guards (same as SessionStart's).
command -v dridock >/dev/null 2>&1 || exit 0
dridock team roster >/dev/null 2>&1 || exit 0
_self="$(dridock team whoami 2>/dev/null | head -1 || true)"
[ -n "$_self" ] || exit 0

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

# ── Check 1: fetcher liveness ────────────────────────────────────────
_fetcher_alive=0
if [ -f "$_pid" ]; then
    _pidval="$(cat "$_pid" 2>/dev/null || true)"
    if [ -n "$_pidval" ] && kill -0 "$_pidval" 2>/dev/null; then
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
        # Surface last log line for diagnosis + respawn.
        if [ -f "$_log" ]; then
            _last_log="$(tail -n 1 "$_log" 2>/dev/null || true)"
            [ -n "$_last_log" ] && echo "⚠ team fetcher: died — last log line: $_last_log"
        fi
        rm -f "$_pid"
        ( nohup dridock team watch --inbox "$_inbox" >>"$_log" 2>&1 & disown ) >/dev/null 2>&1 || true
        echo "$_now" > "$_respawn_stamp"
        echo "🚀 team fetcher: respawned (log at $_log)."
    fi
fi

# ── Check 2: consumer liveness ───────────────────────────────────────
# Only meaningful if the inbox actually exists and has content.
[ -f "$_inbox" ] || exit 0
_inbox_size=$(stat -c %s "$_inbox" 2>/dev/null || stat -f %z "$_inbox" 2>/dev/null || echo 0)

# What did we drain up to for this session?
_last_offset=0
if [ -n "$_session_id" ] && [ -f "$_cursors" ] && command -v jq >/dev/null 2>&1; then
    _v="$(jq -r --arg id "$_session_id" '.[$id] // empty' "$_cursors" 2>/dev/null || true)"
    if [ -n "$_v" ] && [ "$_v" != "null" ]; then _last_offset="$_v"; fi
fi

# Nothing new since last drain → nothing to do.
if [ "$_inbox_size" -le "$_last_offset" ]; then exit 0; fi

# Something new AND we haven't consumed it. Is a tail process consuming
# this inbox file? pgrep matches the exact inbox path in the tail cmd.
_tail_pid=""
if command -v pgrep >/dev/null 2>&1; then
    _tail_pid="$(pgrep -f "tail -F.*$_inbox" 2>/dev/null | head -1 || true)"
fi

if [ -n "$_tail_pid" ]; then
    # Tail is running — Monitor is consuming. The stale drain offset just
    # hasn't been updated yet (the SessionStart hook is where updates
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

# Update cursor to current EOF so we don't re-surface these on the next turn.
if [ -n "$_session_id" ] && command -v jq >/dev/null 2>&1; then
    if [ ! -f "$_cursors" ]; then echo '{}' > "$_cursors"; fi
    _tmp="$(mktemp)"
    if jq --arg id "$_session_id" --argjson off "$_inbox_size" '. + {($id): $off}' "$_cursors" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$_cursors"
    else
        rm -f "$_tmp"
    fi
fi

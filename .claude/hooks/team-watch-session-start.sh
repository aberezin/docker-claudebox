#!/usr/bin/env bash
# SessionStart hook (team-watch, spec #56 delivery model): the 3-step
# arm-then-drain-then-instruct sequence that makes team-bus delivery
# reliable-by-construction rather than by-remembering.
#
# Step 1 — SPAWN the fetcher (if not already running).
# The fetcher is `dridock team watch --inbox <path>`: a detached
# (nohup) background process that polls GitHub and appends each
# surfaced event as one JSONL line to a per-agent inbox file. Detached
# means it survives session teardown; the next SessionStart's `pgrep`
# finds it and skips the respawn. Per-agent inbox files make consumer
# starvation impossible (Bear and Arfy write to different files —
# there's no shared cursor between agents; the fetcher's own dedup
# cursor lives in <xdg>/watch-cursors/, orthogonal to the inbox).
#
# Step 2 — DRAIN unread inbox events into SessionStart context.
# The hook prints the byte range `[last_drain_offset, current_EOF)` to
# stdout — Claude Code injects that as SessionStart context, so events
# that landed while THIS session was down surface at boot. Per-session
# drain offsets live in `<inbox>.session-cursors.json` keyed by
# session_id (Claude Code's session id is stable across resume — Alan
# confirmed). Unknown session id defaults to CURRENT EOF with a loud
# stderr note (spec #56 open loop #3: never replay-all, never silent
# EOF).
#
# Step 3 — PRINT the exact Monitor arm command with the substituted
# offset. Handoff-race safe (#56 open loop #1): the Monitor's tail
# starts at `current_EOF + 1`, and the fetcher continues appending past
# `current_EOF` — the drain covered up-to-EOF, the tail covers
# EOF-onwards, no gap.
#
# Idempotent — no-ops when: (a) no `dridock`, (b) no team roster,
# (c) no self-name resolvable.
set -u

# ─── graceful no-op: skip silently if `dridock` isn't on PATH ────────
if ! command -v dridock >/dev/null 2>&1; then
    exit 0
fi

# ─── project guard: no team roster → no team, no work ─────────────────
if ! dridock team roster >/dev/null 2>&1; then
    exit 0
fi

# ─── read Claude's SessionStart JSON payload for session_id ────────────
# Payload shape: {"session_id":"...","hook_event_name":"SessionStart",
#                 "cwd":"...","source":"startup|resume|clear"}
# stdin might be an empty pipe (no payload from CC) — tolerate that.
_payload="$(cat 2>/dev/null || echo '')"
_session_id=""
if [ -n "$_payload" ] && command -v jq >/dev/null 2>&1; then
    _session_id="$(printf '%s' "$_payload" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

# ─── resolve self name ────────────────────────────────────────────────
# `dridock team whoami` prints the agent name on stdout (or errors on
# stderr if unresolvable — multi-agent roster with no DRIDOCK_AGENT_NAME).
_self="$(dridock team whoami 2>/dev/null | head -1 || true)"
if [ -z "$_self" ]; then
    exit 0
fi

# ─── convention paths ────────────────────────────────────────────────
_xdg="${XDG_CONFIG_HOME:-$HOME/.config}"
_inbox="$_xdg/dridock/inbox/$_self.jsonl"
_pid="$_inbox.pid"
_log="$_inbox.log"
_cursors="$_inbox.session-cursors.json"
mkdir -p "$(dirname "$_inbox")"

# ─── Step 1: fetcher liveness → spawn if dead/missing ────────────────
_spawn_fetcher=0
if [ -f "$_pid" ]; then
    _pidval="$(cat "$_pid" 2>/dev/null || true)"
    if [ -n "$_pidval" ] && kill -0 "$_pidval" 2>/dev/null; then
        : # alive — nothing to do
    else
        # Stale pidfile → the previous fetcher died. Surface the log's
        # last line so an immediate-crash loop is diagnosable, then
        # respawn.
        if [ -f "$_log" ]; then
            _last_log="$(tail -n 1 "$_log" 2>/dev/null || true)"
            if [ -n "$_last_log" ]; then
                echo "⚠ team fetcher: previous fetcher died (pid $_pidval no longer alive). Last log line: $_last_log"
                echo "  Full log: $_log"
            fi
        fi
        rm -f "$_pid"
        _spawn_fetcher=1
    fi
else
    _spawn_fetcher=1
fi

if [ "$_spawn_fetcher" = 1 ]; then
    # Detach fully: stdin from /dev/null, stdout+stderr to log, subshell
    # + disown so this hook can exit while the fetcher lives on.
    ( nohup dridock team watch --inbox "$_inbox" >>"$_log" 2>&1 & disown ) >/dev/null 2>&1 || true
    echo "🚀 team fetcher: spawned (nohup, detached). log=$_log"
fi

# ─── Step 2: drain unread inbox slice into SessionStart context ──────
_inbox_size=0
if [ -f "$_inbox" ]; then
    _inbox_size=$(stat -c %s "$_inbox" 2>/dev/null || stat -f %z "$_inbox" 2>/dev/null || echo 0)
fi

# Determine last drain offset for this session.
_last_offset=0
_drain_note=""
if [ -n "$_session_id" ] && [ -f "$_cursors" ] && command -v jq >/dev/null 2>&1; then
    _lookup="$(jq -r --arg id "$_session_id" '.[$id] // empty' "$_cursors" 2>/dev/null || true)"
    if [ -n "$_lookup" ] && [ "$_lookup" != "null" ]; then
        _last_offset="$_lookup"
    else
        # Unknown session id → default to EOF. Loud stderr note per spec.
        _last_offset="$_inbox_size"
        _drain_note="unknown session_id '$_session_id' → defaulting to current EOF (not replaying inbox)"
    fi
elif [ -z "$_session_id" ]; then
    _last_offset="$_inbox_size"
    _drain_note="no session_id in hook payload → defaulting to current EOF"
elif [ ! -f "$_cursors" ]; then
    _last_offset="$_inbox_size"
    _drain_note="no cursors file yet → defaulting to current EOF (first session)"
elif ! command -v jq >/dev/null 2>&1; then
    _last_offset="$_inbox_size"
    _drain_note="jq not available → defaulting to current EOF"
fi

# Emit drain contents (byte range) if there's anything new.
if [ "$_inbox_size" -gt "$_last_offset" ] && [ -f "$_inbox" ]; then
    _delta=$((_inbox_size - _last_offset))
    echo ""
    echo "─── team-inbox catch-up: $_delta bytes since offset $_last_offset ───"
    tail -c "+$((_last_offset + 1))" "$_inbox" | head -c "$_delta"
    echo "─── end catch-up ───"
fi

# Update the cursors file to current EOF (advance the drain offset).
if [ -n "$_session_id" ] && command -v jq >/dev/null 2>&1; then
    if [ ! -f "$_cursors" ]; then echo '{}' > "$_cursors"; fi
    _tmp="$(mktemp)"
    if jq --arg id "$_session_id" --argjson off "$_inbox_size" '. + {($id): $off}' "$_cursors" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$_cursors"
    else
        rm -f "$_tmp"
    fi
fi

# Loud stderr note (never silent EOF).
if [ -n "$_drain_note" ]; then
    echo "⚠ team-inbox drain: $_drain_note" >&2
fi

# ─── Step 3: print the exact Monitor arm command ─────────────────────
# Handoff-race safe: tail starts at `current_EOF + 1`; the fetcher
# continues appending past `current_EOF`; no gap between drain and arm.
echo ""
echo "📬 team-inbox live layer — arm your Monitor tool with this EXACT command (persistent):"
echo "    tail -F -c +$((_inbox_size + 1)) $_inbox"
echo "  Each new line = one team-bus event addressed to $_self. Monitor turns each"
echo "  line into a chat notification. Do NOT run this in a terminal — its stdout"
echo "  won't reach this Claude session."

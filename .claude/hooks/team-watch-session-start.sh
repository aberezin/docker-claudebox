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

# ─── version gate: `--inbox` needs 4.2.0+ ────────────────────────────
# A branch checkout without ./install.sh arms these hooks against a
# pre-4.2.0 binary. --inbox mode + fetcher verbs aren't there yet;
# spawning would immediately crash with "unexpected argument".
# Refuse loudly and instruct the fix (Arfy's related-#1 finding on #56).
if dridock team fetcher status --inbox /dev/null 2>&1 | grep -q "unknown subcommand"; then
    echo "⚠ team-watch: installed dridock binary predates 4.2.0 (missing 'fetcher' verb) — skipping this hook."
    echo "  Fix: on the host, git pull + ./install.sh; in-container, make build + dridock down + dridock start."
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
# Two-part liveness (spec #56 open loop #4): kill -0 AND ps cmdline
# match. After a reboot the recorded pid is very likely held by an
# unrelated process → kill -0 succeeds → without cmdline check we'd
# green-light silent starvation. Match on "dridock team watch" AND the
# specific inbox path (unique per agent+env by construction).
_check_fetcher_alive() {
    local pid="$1"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    ps -p "$pid" -o command= 2>/dev/null | grep -qF "dridock team watch" || return 1
    ps -p "$pid" -o command= 2>/dev/null | grep -qF "$_inbox" || return 1
    return 0
}

_spawn_fetcher=0
if [ -f "$_pid" ]; then
    _pidval="$(cat "$_pid" 2>/dev/null || true)"
    if _check_fetcher_alive "$_pidval"; then
        : # alive AND cmdline matches — nothing to do
    else
        # Stale pidfile → the previous fetcher died OR the pid was
        # reused by an unrelated process (reboot / wraparound).
        # Surface log's last line so an immediate-crash loop is
        # diagnosable, then respawn.
        if [ -f "$_log" ]; then
            _last_log="$(tail -n 1 "$_log" 2>/dev/null || true)"
            if [ -n "$_last_log" ]; then
                echo "⚠ team fetcher: previous fetcher gone (pid $_pidval not alive or cmdline mismatch). Last log line: $_last_log"
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

    # Verify the spawn actually took (Arfy's nit #1): a subshell + &
    # returns immediately regardless of the child's fate, so we need to
    # check pidfile appeared + pid matches expected cmdline before
    # claiming "spawned". If the child died at startup (missing binary,
    # rejected flag, permission), surface the log so it's obvious.
    sleep 1
    _spawn_pid="$(cat "$_pid" 2>/dev/null || true)"
    if _check_fetcher_alive "$_spawn_pid"; then
        echo "🚀 team fetcher: spawned (nohup, detached, pid=$_spawn_pid). log=$_log"
    else
        echo "⚠ team fetcher: spawn attempted but pid not alive OR cmdline mismatch."
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

# Emit drain contents (byte range) if there's anything new. Track
# whether we actually drained so the cursor advance below only fires
# on the drain-emitted path — Arfy's blocking finding on #56/#59:
# advancing the cursor unconditionally means a run that skipped
# catch-up still marks the skipped window as consumed, silently
# dropping the events AND erasing the evidence that would identify
# which branch ran.
_drain_fired=0
if [ "$_inbox_size" -gt "$_last_offset" ] && [ -f "$_inbox" ]; then
    _delta=$((_inbox_size - _last_offset))
    echo ""
    echo "─── team-inbox catch-up: $_delta bytes since offset $_last_offset ───"
    tail -c "+$((_last_offset + 1))" "$_inbox" | head -c "$_delta"
    echo "─── end catch-up ───"
    _drain_fired=1
fi

# Update the cursors file — ONLY when drain actually fired. On a skip
# (whether because there was nothing new, or because the unknown-
# session fallback set _last_offset=EOF), leave the cursor entry
# untouched. A subsequent hook run then re-evaluates from real state
# instead of the previous run's misleading "cursor at EOF" write.
if [ "$_drain_fired" = 1 ] && [ -n "$_session_id" ] && command -v jq >/dev/null 2>&1; then
    if [ ! -f "$_cursors" ]; then echo '{}' > "$_cursors"; fi
    _tmp="$(mktemp)"
    if jq --arg id "$_session_id" --argjson off "$_inbox_size" '. + {($id): $off}' "$_cursors" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$_cursors"
    else
        rm -f "$_tmp"
    fi
fi

# Loud note when we defaulted to EOF (never silent skip). Emit on
# STDOUT — Claude Code injects SessionStart stdout as session context;
# stderr is not surfaced. Arfy's blocking finding: the one loud signal
# for exactly this case was going to a channel the agent never reads.
if [ -n "$_drain_note" ]; then
    echo ""
    echo "⚠ team-inbox drain: $_drain_note"
    if [ "$_inbox_size" -gt 0 ]; then
        echo "  Inbox contains $_inbox_size bytes; you can inspect with:"
        echo "    less $_inbox"
        echo "  or replay from the beginning by removing $_cursors and re-arming."
    fi
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

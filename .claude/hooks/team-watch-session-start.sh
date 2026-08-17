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
    # Capture log size BEFORE we spawn — nohup appends (`>>`), the log
    # is never truncated or rotated, and every previous fetcher lifetime
    # left its config-line + any FRESH START warning behind. If we grep
    # the whole file for THIS spawn's output, a stale FRESH START from a
    # long-dead fetcher gets re-announced forever — asserting the
    # opposite of the truth on every subsequent spawn (Arfy's #58 repro
    # on 27a4a01). Slice by byte-offset instead, matching the drain +
    # Monitor-arm idiom already used elsewhere in this hook.
    _log_size_before=0
    if [ -f "$_log" ]; then
        _log_size_before=$(stat -c %s "$_log" 2>/dev/null || stat -f %z "$_log" 2>/dev/null || echo 0)
    fi

    # Detach fully: stdin from /dev/null, stdout+stderr to log, subshell
    # + disown so this hook can exit while the fetcher lives on.
    #
    # NOTE (#70 followup): I tried piping through
    # `awk '{ print strftime(...), $0; fflush() }'` here to add
    # per-line ISO-8601 timestamps for the jq-death open loop. It
    # doesn't work: Bun's stderr buffering behavior differs when the
    # destination is a pipe vs a file. On direct-to-file (this shape)
    # each line is line-buffered and appears immediately; on
    # pipe-to-awk they bunch up in Bun's internal buffer and never
    # reach awk (verified: awk process alive, pipe wired, but zero
    # bytes flow through for a running `team watch` loop; a
    # short-lived `team whoami` DOES flow because Bun flushes on
    # exit). `stdbuf -oL -eL` didn't help — Bun bypasses libc stdio.
    # Solution needs to be TS-side (timestamp inside the fetcher's
    # own write path), not shell-side. Filed as a follow-up.
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
        # Surface any FRESH START warning from THIS spawn's log output
        # (bytes appended after `_log_size_before`). Rule: a diagnostic
        # must be derived from the CURRENT run's state, not from
        # accumulated state that merely contains it (Arfy's #58 pattern
        # observation — the third instance tonight of right-signal /
        # wrong-provenance).
        if [ -f "$_log" ] && tail -c "+$((_log_size_before + 1))" "$_log" 2>/dev/null | grep -qF "FRESH START"; then
            echo ""
            # 4 lines: the warning header + 3 body lines from TeamCommand.
            tail -c "+$((_log_size_before + 1))" "$_log" 2>/dev/null | grep -A3 -F "FRESH START" | head -4
        fi
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

# Integer validator — treats anything non-decimal-digit as invalid.
# Used to guard offsets read from the cursors file: a corrupt file
# (string values, non-object shape, partial write, future schema) can
# yield "abc" or "object" instead of an integer, which then explodes in
# `-gt`/`-le` arithmetic downstream. Arfy caught this on #56 review:
# without validation, garbage lands in the drain-note ("catch-up from
# max known offset abc") AND the arithmetic error goes to stderr — the
# channel we already established the agent can't see. Same
# trust-the-wrong-signal shape as the review-round originals.
_is_uint() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

# Determine last drain offset for this session.
#
# Fallback strategy for unknown session_id (Arfy's option (d) on #56,
# revised for #58 persistent-inbox trade-off):
#   - Known id      → use its stored offset directly.
#   - Unknown id, cursors file has OTHER entries → infer from
#     max(existing offsets). Catch up from wherever the newest known
#     consumer last got to. Self-heals new session ids without either
#     replay-all or infinite-skip.
#   - Unknown id, cursors file EMPTY / no cursors file at all → default
#     to 0 (drain the full inbox). Pre-#58 (ephemeral inbox), Arfy's
#     refinement chose EOF here to avoid replay-all-on-fresh-install.
#     Post-#58 the inbox PERSISTS across container recreates on the
#     bind-mounted ~/.claude — so a "no cursors file" state is now the
#     signal for "cursor was never established", not "fresh install
#     with nothing to see". EOF here would silently drop any events
#     accumulated in the persistent inbox (Arfy's gap-event repro on
#     0ac6281 exposed this). 0 = drain everything, which under a
#     bounded per-agent inbox is safe and self-establishes the cursor
#     for subsequent runs.
#   - No session_id / no jq → EOF (can't write cursor, so draining
#     would replay every hook run — worse than skip). ORDERING NOTE:
#     the no-jq check runs BEFORE the no-cursors-file check so that
#     drain-from-0 is only reachable when jq is present (Arfy's
#     Finding 1 on 83d65e0). Otherwise no-jq + no-cursors-file would
#     take the drain-from-0 branch, fail to write the cursor, and
#     replay forever.
#   - Cursors file CORRUPT → EOF + rm hint (discarding IS correct
#     recovery).
_last_offset=0
_drain_note=""
if [ -n "$_session_id" ] && [ -f "$_cursors" ] && command -v jq >/dev/null 2>&1; then
    _lookup="$(jq -r --arg id "$_session_id" '.[$id] // empty' "$_cursors" 2>/dev/null || true)"
    if [ -n "$_lookup" ] && [ "$_lookup" != "null" ]; then
        if _is_uint "$_lookup"; then
            _last_offset="$_lookup"
        else
            _last_offset="$_inbox_size"
            _drain_note="cursors file CORRUPT — session_id '$_session_id' has non-integer offset '$_lookup'. Defaulting to current EOF. Recover: rm $_cursors"
        fi
    else
        # Unknown session id → option (d): infer from max of existing offsets.
        _max_known="$(jq -r '. | to_entries | map(.value) | if length > 0 then max else empty end' "$_cursors" 2>/dev/null || true)"
        if [ -n "$_max_known" ] && [ "$_max_known" != "null" ]; then
            if _is_uint "$_max_known"; then
                _last_offset="$_max_known"
                _drain_note="unknown session_id '$_session_id' → catch-up from max known offset $_max_known (newest prior consumer)"
            else
                # max() returning a string means the cursors file
                # isn't the shape we expect (either offset values are
                # strings, or the top-level isn't an object so
                # to_entries produced junk).
                _last_offset="$_inbox_size"
                _drain_note="cursors file CORRUPT — max() returned non-integer '$_max_known'. Defaulting to current EOF. Recover: rm $_cursors"
            fi
        else
            # Unknown id + cursors file exists but empty of entries. No
            # max() evidence, but this session_id is known so we CAN
            # advance a cursor. Under 4.2.1's persistent inbox, draining
            # from 0 self-establishes state without dropping accumulated
            # events. See header comment for the trade-off shift.
            _last_offset=0
            _drain_note="unknown session_id '$_session_id', empty cursors file → draining full inbox to establish this session's baseline"
        fi
    fi
elif [ -z "$_session_id" ]; then
    _last_offset="$_inbox_size"
    _drain_note="no session_id in hook payload → defaulting to current EOF"
elif ! command -v jq >/dev/null 2>&1; then
    # Placed BEFORE the no-cursors-file branch so drain-from-0 is only
    # ever reachable when the cursor write below can actually succeed
    # (Arfy's Finding 1 on 83d65e0). Without jq, the cursor-file write
    # silently no-ops — so if drain-from-0 fired here, the next run
    # would find the same "no cursors" state and drain from 0 again,
    # forever. Invariant made structural: every branch that sets
    # _last_offset=0 is downstream of this check.
    _last_offset="$_inbox_size"
    _drain_note="jq not available → defaulting to current EOF (cursor write would silently fail; drain-from-0 would loop forever)"
elif [ ! -f "$_cursors" ]; then
    # First-ever hook run on this agent (or after `rm <cursors>`
    # recovery). Under 4.2.1 the inbox persists, so anything accumulated
    # in it deserves surfacing on first read — draining from 0
    # establishes the cursor for this session_id and prevents the
    # infinite-EOF-default loop that made Arfy's #58 gap-event repro
    # fail (drain skipped → cursor never written → next hook run also
    # sees "no cursors file" → same skip). Under a bounded per-agent
    # inbox this is safe. jq availability guaranteed by the earlier
    # branch.
    _last_offset=0
    _drain_note="no cursors file yet → draining full inbox (first-ever session on this agent; establishes persistent state)"
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
#
# Cap the file at 10 entries by insertion order (jq preserves object
# key order). The old-session-id-per-run growth is bounded by the
# supervisor process's lifetime, but we still want it bounded — max()
# under option (d) scans the file so a runaway entry count is real
# tail latency.
#
# LOAD-BEARING INVARIANT (Arfy caught this on #56 review): the max()
# fallback is safe against pruning ONLY because the write and the
# prune are ONE jq expression, and the new entry (always current EOF
# of an append-only inbox) is appended LAST. That guarantees the
# newest entry is always the maximum, so evicting the oldest can
# never lower the running max. If you EVER add a standalone GC pass,
# a `fetcher gc` verb, or any repair path that prunes without also
# writing a fresh EOF entry, this invariant BREAKS silently and
# reintroduces exactly the "prune loses max → new session_id gets a
# too-low offset → replays already-seen events" regression.
if [ "$_drain_fired" = 1 ] && [ -n "$_session_id" ] && command -v jq >/dev/null 2>&1; then
    if [ ! -f "$_cursors" ]; then echo '{}' > "$_cursors"; fi
    _tmp="$(mktemp)"
    if jq --arg id "$_session_id" --argjson off "$_inbox_size" \
        '. + {($id): $off} | to_entries | if length > 10 then .[-10:] else . end | from_entries' \
        "$_cursors" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$_cursors"
    else
        rm -f "$_tmp"
    fi
fi

# Loud note when we defaulted to EOF or inferred from max (never silent
# skip). Emit on STDOUT — Claude Code injects SessionStart stdout as
# session context; stderr is not surfaced. Arfy's blocking finding: the
# one loud signal for exactly this case was going to a channel the
# agent never reads.
if [ -n "$_drain_note" ]; then
    echo ""
    echo "⚠ team-inbox drain: $_drain_note"
    if [ "$_inbox_size" -gt 0 ] && [ "$_drain_fired" != 1 ]; then
        # Only advise manual inspection when we truly skipped everything.
        # The recovery path is intentionally NOT "delete cursors + re-run"
        # — that lands right back in the EOF fallback (Arfy caught it as
        # a green-light-on-broken-path bug). Cat the file directly.
        echo "  Inbox has $_inbox_size bytes total; inspect with:"
        echo "    cat $_inbox | jq -s '.'"
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

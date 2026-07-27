#!/usr/bin/env bash
# SessionStart hook (team-watch): the catch-up + arm-nag half of the #45/#46
# reusable watcher — surfaces any pending team messages addressed to THIS
# agent (via `dridock team watch --once`), plus a staleness warning if the
# live-loop watcher (`dridock team watch`) hasn't ticked recently.
#
# Companion of the LIVE layer that runs in a terminal (`dridock team watch`).
# The heartbeat file the live layer writes each poll is what this hook
# checks for staleness → suggests re-arming.
#
# Works in BOTH environments per the same convention as
# `consult-session-start.sh`:
#   - Mac / host: `dridock team watch --once` + `~/.config/dridock/watch-cursors/github.heartbeat`
#   - Container:  no dridock binary in the container (yet — dridock-ts is a HOST
#                 wrapper). Silent no-op until a container-side helper lands
#                 or dridock-ts is baked into the image.
#
# Idempotent — stays silent when: (a) no team roster in $PWD, (b) no pending
# messages, and (c) heartbeat is fresh (or an already-active live loop is
# observably ticking). Never surfaces noise when there's nothing to say.
#
# Non-scope: this hook does NOT arm the live loop — that's a foreground
# terminal decision (long-running). It NUDGES the user to arm it.
set -u

# ─── environment detection ────────────────────────────────────────────
if [ -f /.dockerenv ]; then
    # Container: no dridock wrapper here (host binary). Nothing to run
    # inside the container yet — this hook exists to slot in cleanly
    # once a container-side team-watch helper lands (or dridock-ts gets
    # baked into the image).
    exit 0
fi

# Host: skip silently if the wrapper isn't on PATH.
if ! command -v dridock >/dev/null 2>&1; then
    exit 0
fi

# ─── project guard: no team roster → no team, no work ─────────────────
# Every hook fires for every session; skip when the user is in a project
# that hasn't declared a team roster. `dridock team roster` returns rc 0
# with the roster on stdout iff .dridock/agents.yml exists; rc 1 with a
# "no roster" stderr line otherwise. Swallow both — we're only using it
# as a presence check.
if ! dridock team roster >/dev/null 2>&1; then
    exit 0
fi

# ─── staleness warning ────────────────────────────────────────────────
# The live layer (`dridock team watch`) writes a heartbeat file every
# poll. If it's older than DRIDOCK_WATCH_STALE_SECS (default 5 min), the
# live loop isn't running — nudge the user to arm it. Absent heartbeat
# → first-ever session with a roster → same nudge.
HEARTBEAT="${XDG_CONFIG_HOME:-$HOME/.config}/dridock/watch-cursors/github.heartbeat"
STALE_SECS="${DRIDOCK_WATCH_STALE_SECS:-300}"

warn_stale() {
    echo "⚠ dridock team watch: live loop appears not running ($1)."
    echo "  Arm it: 'dridock team watch' in a terminal (Ctrl-C to stop; state persisted)."
    echo ""
}

if [ -f "$HEARTBEAT" ]; then
    # Portable mtime: GNU stat first (Linux/GNU coreutils on Mac), BSD stat second (macOS default).
    hb_mtime=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$((now - hb_mtime))
    if [ "$age" -gt "$STALE_SECS" ]; then
        warn_stale "heartbeat is ${age}s old (>${STALE_SECS}s)"
    fi
else
    warn_stale "no heartbeat found at $HEARTBEAT"
fi

# ─── catch-up ─────────────────────────────────────────────────────────
# Run one poll cycle to surface events that arrived while THIS session
# wasn't listening (either between-sessions gap OR the live loop was
# down). Stdout from the verb IS what Claude injects as SessionStart
# context — the events land straight into the model's turn.
#
# Suppress stderr — the "self=... repo=... interval=..." config-surface
# line is noise for this use case; failures are non-fatal (soft `poll-
# failed` inside the verb already prints a warning we don't want here).
dridock team watch --once 2>/dev/null || true

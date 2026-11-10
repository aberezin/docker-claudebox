#!/usr/bin/env bash
# #105 — the status line shows the team-inbox watch state (📬 live / off /
# off · N new), using the SAME detection as the UserPromptSubmit hook.
#
# Drives the real .claude/statusline-dridock.sh with a fixture XDG dir and a
# real backgrounded `tail -F`, not a stubbed pgrep — the thing under test is
# what a live tail's cmdline looks like to the shared check, so stubbing the
# reader would test nothing (same reasoning as tests/test_team_inbox_cursor.sh).
# Host-only: no Docker, no token.
#
# Self-registers into ALL_TESTS. Also directly runnable:
#   bash tests/test_statusline_inbox.sh
set -u

_TSI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TSI_REPO="$_TSI_DIR/.."
_TSI_SL="$_TSI_REPO/.claude/statusline-dridock.sh"
_TSI_HOOK="$_TSI_REPO/.claude/hooks/team-watch-user-prompt-submit.sh"

# Render the status line for agent $1 with XDG root $2 and session $3,
# ANSI colour codes stripped so assertions read the visible text.
_tsi_render() {
    printf '{"cwd":"%s","session_id":"%s"}' "$_TSI_REPO" "$3" \
        | DRIDOCK_AGENT_NAME="$1" XDG_CONFIG_HOME="$2" bash "$_TSI_SL" 2>/dev/null \
        | sed 's/\x1b\[[0-9;]*m//g'
}

test_statusline_inbox() {
    local PASS=0 FAIL=0
    ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
    bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

    echo "--- #105 status line: team-inbox watch state ---"

    local xdg inbox out tpid="" tpid2=""
    xdg="$(mktemp -d)"
    mkdir -p "$xdg/dridock/inbox"
    inbox="$xdg/dridock/inbox/Tester.jsonl"

    _tsi_cleanup() {
        [ -n "$tpid" ] && kill "$tpid" 2>/dev/null
        [ -n "$tpid2" ] && kill "$tpid2" 2>/dev/null
        rm -rf "$xdg"
    }

    # ── no inbox → silent (team bus not in use for this agent) ───────
    out="$(_tsi_render Tester "$xdg" s1)"
    case "$out" in
        *📬*) bad "no inbox: expected no 📬 segment, got: $out" ;;
        *)    ok  "no inbox → no 📬 segment" ;;
    esac

    printf '{"e":1}\n{"e":2}\n{"e":3}\n' > "$inbox"
    # Sentinel: every assertion below is about this fixture, so it must exist.
    if [ -s "$inbox" ]; then ok "fixture inbox written"; else
        bad "fixture inbox missing — assertions below are vacuous"; fi

    # ── inbox, no watch, no cursor for this session → off, no count ──
    out="$(_tsi_render Tester "$xdg" s1)"
    case "$out" in
        *"📬 off"*"new"*) bad "no cursor: showed a count, but the hook treats EOF as seen: $out" ;;
        *"📬 off"*)       ok  "no watch, no cursor → '📬 off' with no count (hook's EOF default)" ;;
        *)                bad "no watch: expected '📬 off', got: $out" ;;
    esac

    # ── no watch, cursor behind by two events → off · 2 new ──────────
    printf '{"s2":8}' > "$inbox.session-cursors.json"   # 8 bytes = past event 1
    out="$(_tsi_render Tester "$xdg" s2)"
    case "$out" in
        *"📬 off · 2 new"*) ok  "no watch, cursor behind → '📬 off · 2 new'" ;;
        *)                  bad "expected '📬 off · 2 new', got: $out" ;;
    esac

    # ── a tail on a DIFFERENT agent's inbox doesn't count ────────────
    printf '' > "$xdg/dridock/inbox/Other.jsonl"
    tail -F -c +1 "$xdg/dridock/inbox/Other.jsonl" >/dev/null 2>&1 &
    tpid2=$!
    sleep 0.3
    out="$(_tsi_render Tester "$xdg" s2)"
    case "$out" in
        *"📬 off"*) ok  "a tail on another agent's inbox → still '📬 off'" ;;
        *)          bad "another agent's tail made this one look live: $out" ;;
    esac

    # ── live tail on this inbox → live, and no count ─────────────────
    tail -F -c +9 "$inbox" >/dev/null 2>&1 &
    tpid=$!
    sleep 0.3
    out="$(_tsi_render Tester "$xdg" s2)"
    case "$out" in
        *"📬 live"*"new"*) bad "live: showed a count — the cursor lags a live watch until the next prompt: $out" ;;
        *"📬 live"*)       ok  "live tail → '📬 live', no count" ;;
        *)                 bad "live tail: expected '📬 live', got: $out" ;;
    esac

    # ── watch ends → back to off ─────────────────────────────────────
    kill "$tpid" 2>/dev/null; wait "$tpid" 2>/dev/null; tpid=""
    out="$(_tsi_render Tester "$xdg" s2)"
    case "$out" in
        *"📬 off"*) ok  "tail killed → back to '📬 off'" ;;
        *)          bad "after the tail died: expected '📬 off', got: $out" ;;
    esac

    # ── one definition: hook and status line share the check ─────────
    # The point of #105's constraint. If the hook regrows its own inline
    # pgrep loop, the two can drift and the status line says "live" while
    # the hook nags "NOT armed".
    if grep -q 'lib/team-inbox-watch.sh' "$_TSI_HOOK" && grep -q 'twh_find_tail' "$_TSI_HOOK"; then
        ok "the hook sources the shared check"
    else
        bad "the hook no longer sources lib/team-inbox-watch.sh"
    fi
    if grep -q "pgrep -f 'tail -F'" "$_TSI_HOOK"; then
        bad "the hook has its own inline 'tail -F' scan again — a second copy of the check"
    else
        ok "the hook carries no inline copy of the scan"
    fi
    if grep -q 'lib/team-inbox-watch.sh' "$_TSI_SL" && grep -q 'twh_find_tail' "$_TSI_SL"; then
        ok "the status line sources the shared check"
    else
        bad "the status line no longer sources lib/team-inbox-watch.sh"
    fi

    _tsi_cleanup
    echo "  #105 status line inbox: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_statusline_inbox)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_statusline_inbox
fi

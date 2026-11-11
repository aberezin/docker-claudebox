#!/usr/bin/env bash
# #102 — the inbox cursor must account for what the Monitor's `tail -F`
# delivered, not only for what the hook itself drained.
#
# THE BUG: the inbox has TWO consumers — the hook's in-line drain, and the
# Monitor's live `tail -F`. Only the drain advanced the session cursor. While a
# tail was alive the hook `exit 0`'d without touching it, on the premise that
# "SessionStart is where updates happen" — but SessionStart runs ONCE per
# session. So across a long session with several Monitor arm/expire cycles the
# cursor stayed frozen at whatever it was when the first tail came up, and the
# moment that Monitor expired the next turn computed its delta from the frozen
# cursor and REPLAYED every event the Monitor had already delivered. Seen three
# times in one session, each with the cursor at exactly `arm_offset - 1`.
#
# These drive the REAL hook with a REAL backgrounded `tail -F` on a fixture
# inbox, rather than stubbing pgrep/ps — the whole mechanism under test is
# "what can the hook learn from a live tail's cmdline", so stubbing the thing
# that reads that cmdline would test nothing. Host-only: no Docker, no token.
#
# Self-registers into ALL_TESTS. Also directly runnable:
#   bash tests/test_team_inbox_cursor.sh
set -u

_TIC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TIC_HOOK="$_TIC_DIR/../.claude/hooks/team-watch-user-prompt-submit.sh"

_tic_stub_dridock() {
    mkdir -p "$1"
    cat > "$1/dridock" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    "team roster")  exit 0 ;;
    "team whoami")  echo "Bear"; exit 0 ;;
    # Stand in for the detached fetcher: the hook's liveness check wants a
    # live pid whose cmdline contains BOTH "dridock team watch" and the inbox
    # path, so this script's own argv satisfies it while it sleeps.
    "team watch")   sleep 600 ;;  # NOT exec: exec would replace argv and lose the cmdline the hook matches
    *)              exit 0 ;;
esac
STUB
    chmod +x "$1/dridock"
}

# Run the hook with a controlled XDG root + session id. Sets _TIC_OUT/_TIC_RC.
# No inbox socket: run from inside a Claude session, the runner's own socket
# (plus an `accept` in its user settings) would switch on #107's socket
# delivery and this suite would be testing the runner, not the Monitor path.
_tic_run() {
    local stub="$1" xdg="$2" sid="$3"
    _TIC_OUT="$(printf '{"session_id":"%s"}' "$sid" \
        | env -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
            PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" bash "$_TIC_HOOK" 2>/dev/null)"
    _TIC_RC=$?
}

_tic_cursor() { jq -r --arg id "$2" '.[$id] // "none"' "$1" 2>/dev/null || echo "none"; }

# The hook respawns (and then reports on) the detached fetcher BEFORE it gets
# anywhere near the cursor logic, and bails out of the whole run if the respawn
# looks dead. So these tests need a process that passes `_check_fetcher_alive`:
# a live pid whose `ps` cmdline contains "dridock team watch" and the inbox.
# NOTE: deliberately no `$inbox.version` file — the hook's version-drift
# restart needs both that and `dridock --version` to be non-empty, and the stub
# answers neither, so the drift branch stays out of the way.
_tic_start_fake_fetcher() {
    local stub="$1" inbox="$2"
    "$stub/dridock" team watch --inbox "$inbox" >/dev/null 2>&1 &
    local fp=$!
    echo "$fp" > "$inbox.pid"
    sleep 0.3
    printf '%s' "$fp"
}

test_team_inbox_cursor() {
    local PASS=0 FAIL=0
    ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
    bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

    echo "--- #102 inbox cursor vs the Monitor's tail ---"

    if ! command -v jq >/dev/null 2>&1; then
        bad "jq is required for these tests (the cursor file is JSON)"
        echo "  #102 inbox cursor: $PASS passed, $FAIL failed"
        return 1
    fi

    local stub xdg inbox cursors tails
    stub="$(mktemp -d)"; xdg="$(mktemp -d)"; tails=""
    _tic_stub_dridock "$stub"
    mkdir -p "$xdg/dridock/inbox"
    inbox="$xdg/dridock/inbox/Bear.jsonl"
    cursors="$inbox.session-cursors.json"
    printf '{"e":1}\n' > "$inbox"
    # Seed a cursor at 0. Without one the hook deliberately treats current EOF
    # as already-seen, so a brand-new session isn't flooded with history --
    # correct behavior, but it means an unseeded fixture can never produce a
    # drain and every drain assertion below would be vacuous.
    printf '{"sess-A":0}' > "$cursors"
    local fetcher; fetcher="$(_tic_start_fake_fetcher "$stub" "$inbox")"
    tails="$tails $fetcher"
    # Sentinel: if the stand-in fetcher isn't alive the hook exits at its
    # respawn stage and never reaches the cursor logic -- every "nothing was
    # surfaced" assertion below would then pass for entirely the wrong reason.
    # That is exactly how #98's suite reported 11/2 with four false passes.
    if kill -0 "$fetcher" 2>/dev/null; then
        ok "stand-in fetcher alive (pid=$fetcher) — hook will reach the cursor logic"
    else
        bad "stand-in fetcher died — the assertions below would be vacuous"
    fi

    _tic_cleanup() {
        local p
        for p in $tails; do kill "$p" 2>/dev/null || true; done
        rm -rf "$stub" "$xdg"
    }

    # ── case 1: no tail → ordinary drain still works (regression guard) ─────
    local size1; size1=$(stat -c %s "$inbox" 2>/dev/null || stat -f %z "$inbox")
    # Sentinel: an assertion about a fixture only means something if it exists.
    if [ -s "$inbox" ]; then ok "fixture inbox written ($size1 bytes)"; else
        bad "fixture inbox missing — every assertion below is vacuous"; fi

    _tic_run "$stub" "$xdg" "sess-A"
    if printf '%s' "$_TIC_OUT" | grep -q 'unread bytes since offset'; then
        ok "case 1: no tail → drains in-line"
    else
        bad "case 1: expected an in-line delta; got: $(printf '%s' "$_TIC_OUT" | head -2)"
    fi
    if [ "$(_tic_cursor "$cursors" sess-A)" = "$size1" ]; then
        ok "case 1: cursor advanced to EOF ($size1)"
    else
        bad "case 1: cursor is $(_tic_cursor "$cursors" sess-A), expected $size1"
    fi

    # ── case 2: THE BUG — live tail armed contiguously, new events land ─────
    # Monitor is armed at cursor+1 and is delivering. The hook must advance the
    # cursor to cover what the tail delivered, so a later expiry doesn't replay.
    tail -F -c +$((size1 + 1)) "$inbox" >/dev/null 2>&1 &
    local tpid=$!; tails="$tails $tpid"
    sleep 0.3
    printf '{"e":2}\n{"e":3}\n' >> "$inbox"
    local size2; size2=$(stat -c %s "$inbox" 2>/dev/null || stat -f %z "$inbox")

    _tic_run "$stub" "$xdg" "sess-A"
    if [ "$(_tic_cursor "$cursors" sess-A)" = "$size2" ]; then
        ok "case 2: live tail → cursor advanced to $size2 (the #102 fix)"
    else
        bad "case 2: cursor is $(_tic_cursor "$cursors" sess-A), expected $size2 — tail-delivered events will be replayed"
    fi
    if ! printf '%s' "$_TIC_OUT" | grep -q 'unread bytes since offset'; then
        ok "case 2: nothing re-surfaced in-line while the tail is live"
    else
        bad "case 2: surfaced a delta even though the Monitor is consuming"
    fi

    # ── case 3: the Monitor expires → NO replay of what it delivered ───────
    kill "$tpid" 2>/dev/null || true
    sleep 0.3
    _tic_run "$stub" "$xdg" "sess-A"
    if ! printf '%s' "$_TIC_OUT" | grep -q 'unread bytes since offset'; then
        ok "case 3: after expiry, no replay (this is the symptom #102 reported)"
    else
        bad "case 3: REPLAYED tail-delivered events: $(printf '%s' "$_TIC_OUT" | grep -o 'unread bytes since offset [0-9]*')"
    fi

    # ── case 4: a GAP ahead of the tail's window must still be surfaced ────
    # Events landed BEFORE the Monitor was armed: delivered by nobody. The fix
    # must not advance blindly past them — that trades duplicates for silent
    # loss, the worse half of the never-silently-discard rule.
    printf '{"gap":1}\n' >> "$inbox"
    local gap_start; gap_start=$(stat -c %s "$inbox" 2>/dev/null || stat -f %z "$inbox")
    printf '{"after":1}\n' >> "$inbox"
    local size4; size4=$(stat -c %s "$inbox" 2>/dev/null || stat -f %z "$inbox")
    # Arm the tail AFTER the gap event, so [cursor, gap_start) is uncovered.
    tail -F -c +$((gap_start + 1)) "$inbox" >/dev/null 2>&1 &
    local tpid2=$!; tails="$tails $tpid2"
    sleep 0.3

    _tic_run "$stub" "$xdg" "sess-A"
    if printf '%s' "$_TIC_OUT" | grep -q 'arrived before your Monitor'; then
        ok "case 4: the uncovered gap is surfaced, not skipped"
    else
        bad "case 4: gap silently skipped — expected a 'arrived before your Monitor' block"
    fi
    if printf '%s' "$_TIC_OUT" | grep -qF '{"gap":1}'; then
        ok "case 4: the gap event's actual content was shown"
    else
        bad "case 4: gap block did not contain the undelivered event"
    fi
    if [ "$(_tic_cursor "$cursors" sess-A)" = "$size4" ]; then
        ok "case 4: cursor then advanced past the tail's window ($size4)"
    else
        bad "case 4: cursor is $(_tic_cursor "$cursors" sess-A), expected $size4"
    fi
    kill "$tpid2" 2>/dev/null || true
    sleep 0.3

    # ── case 5: a tail with no readable arm offset → cursor left alone ─────
    # `tail -F <file>` (no -c +N). The hook can't know what it covered, so the
    # old conservative behavior stands: duplicates are the safe failure.
    printf '{"e":9}\n' >> "$inbox"
    local before5; before5="$(_tic_cursor "$cursors" sess-A)"
    tail -F "$inbox" >/dev/null 2>&1 &
    local tpid3=$!; tails="$tails $tpid3"
    sleep 0.3
    _tic_run "$stub" "$xdg" "sess-A"
    if [ "$(_tic_cursor "$cursors" sess-A)" = "$before5" ]; then
        ok "case 5: unparseable arm offset → cursor unchanged (safe fallback)"
    else
        bad "case 5: cursor moved from $before5 to $(_tic_cursor "$cursors" sess-A) without knowing the tail's range"
    fi
    kill "$tpid3" 2>/dev/null || true

    _tic_cleanup
    echo "  #102 inbox cursor: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_team_inbox_cursor)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_team_inbox_cursor
fi

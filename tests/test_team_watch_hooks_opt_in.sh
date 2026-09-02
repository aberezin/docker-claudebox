#!/usr/bin/env bash
# Bash-only tests for the team-watch hooks' opt-in gate + identity check (#85).
#
# WHAT THIS COVERS: the four branches in team-watch-{session-start,
# user-prompt-submit}.sh that decide whether the team bus is armed for a
# session. Pre-#85 the hooks silently `exit 0` on ANY failure of
# `dridock team roster` or `dridock team whoami`, which conflates:
#     (a) user never opted in                    ← should be silent
#     (b) roster file exists but is broken        ← should be LOUD
#     (c) roster fine but identity is broken      ← should be LOUD
# Post-#85 the CLI returns rc=2 for (a) and rc=1 for (b), and the hooks
# branch on that. This test pins the branching by stubbing `dridock` on
# PATH — no Docker, no live API, no auth token.
#
# WHAT THIS DOES NOT COVER: the CLI's own project-root resolution
# (git-toplevel via ProjectRootResolver). That's a CLI contract exercised
# in dridock-ts/src/cli/commands/TeamCommand.test.ts — the hook trusts
# the rc it gets back, so a stub `dridock` that returns the right rc
# faithfully models the real CLI's behavior from any CWD.
#
# Self-registers into ALL_TESTS. Also directly runnable:
#   bash tests/test_team_watch_hooks_opt_in.sh
set -u

_TWH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TWH_HOOKS_DIR="$_TWH_DIR/../.claude/hooks"

# Build a stub `dridock` in $1 that responds to `team roster` / `team whoami` /
# `team fetcher status` based on env vars. Any other subcommand returns rc 0
# with no output (harmless — hooks that reach past the gates spawn a fetcher,
# and we assert BEFORE that stage anyway).
_twh_make_stub_dridock() {
    local dir="$1"
    mkdir -p "$dir"
    cat > "$dir/dridock" <<'STUB'
#!/usr/bin/env bash
# Stub dridock for hook tests. Reads:
#   _STUB_ROSTER_RC   (default 0)
#   _STUB_ROSTER_ERR  (default "")
#   _STUB_WHOAMI_RC   (default 0)
#   _STUB_WHOAMI_OUT  (default "Bear")
#   _STUB_WHOAMI_ERR  (default "  (from DRIDOCK_AGENT_NAME env)")
case "${1:-} ${2:-}" in
    "team roster")
        [ -n "${_STUB_ROSTER_ERR:-}" ] && printf '%s\n' "$_STUB_ROSTER_ERR" >&2
        exit "${_STUB_ROSTER_RC:-0}"
        ;;
    "team whoami")
        [ -n "${_STUB_WHOAMI_OUT:-Bear}" ] && printf '%s\n' "${_STUB_WHOAMI_OUT:-Bear}"
        [ -n "${_STUB_WHOAMI_ERR:-  (from DRIDOCK_AGENT_NAME env)}" ] \
            && printf '%s\n' "${_STUB_WHOAMI_ERR:-  (from DRIDOCK_AGENT_NAME env)}" >&2
        exit "${_STUB_WHOAMI_RC:-0}"
        ;;
    "team fetcher")
        # Version gate probe. The hook greps stderr for "unknown subcommand" —
        # emit nothing so it thinks the binary is current.
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
STUB
    chmod +x "$dir/dridock"
}

# Run team-watch-session-start.sh with the stub dridock on PATH.
# Captures stdout + rc into globals `_TWH_STDOUT` and `_TWH_RC`.
_twh_run_session_start_hook() {
    local stub_dir="$1"
    _TWH_STDOUT="$(PATH="$stub_dir:$PATH" bash "$_TWH_HOOKS_DIR/team-watch-session-start.sh" </dev/null 2>/dev/null)"
    _TWH_RC=$?
}

test_team_watch_hooks_opt_in() {
    local PASS=0 FAIL=0
    ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
    bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

    local stub_dir; stub_dir="$(mktemp -d)"
    _twh_make_stub_dridock "$stub_dir"
    # trap cleanup covers early return via `[ FAIL -eq 0 ]` at the end
    trap 'rm -rf "$stub_dir"' RETURN

    echo "--- team-watch hooks: opt-in gate + identity (#85) ---"

    # Case 1: no roster (rc=2) → SILENT exit 0
    # Ordinary user who never opted into agent-teams. Emitting a banner
    # here would be a worse bug than the one this fix addresses.
    _STUB_ROSTER_RC=2 _STUB_ROSTER_ERR="❌ agent-teams: no roster at /whatever" \
        _twh_run_session_start_hook "$stub_dir"
    if [ "$_TWH_RC" = 0 ] && [ -z "$_TWH_STDOUT" ]; then
        ok "case 1: no roster (rc=2) → silent exit 0"
    else
        bad "case 1: expected rc=0 + empty stdout; got rc=$_TWH_RC stdout=$(printf '%q' "$_TWH_STDOUT")"
    fi

    # Case 2: corrupt roster (rc=1) → LOUD exit 0 with CLI stderr surfaced
    _STUB_ROSTER_RC=1 _STUB_ROSTER_ERR="❌ team: malformed roster at /proj/.dridock/agents.yml: line 3: unknown agent field 'bogus'" \
        _twh_run_session_start_hook "$stub_dir"
    if [ "$_TWH_RC" = 0 ] \
        && printf '%s' "$_TWH_STDOUT" | grep -q "team-bus OFF" \
        && printf '%s' "$_TWH_STDOUT" | grep -q "malformed roster"; then
        ok "case 2: corrupt roster (rc=1) → loud exit 0, CLI stderr surfaced"
    else
        bad "case 2: expected rc=0 + team-bus-OFF banner containing CLI stderr; got rc=$_TWH_RC"
        printf '  stdout: %s\n' "$_TWH_STDOUT" | head -5
    fi

    # Case 3: roster fine but whoami fails (typo in DRIDOCK_AGENT_NAME) → LOUD
    # This is the case #85's title names — Alan's original question. The
    # CLI's own error is already actionable ("Roster has: Bear, Arfy — pick
    # one, or add 'Nonexistent'..."), just needs to not be discarded.
    _STUB_WHOAMI_RC=1 _STUB_WHOAMI_OUT="" \
        _STUB_WHOAMI_ERR="❌ agent-teams: DRIDOCK_AGENT_NAME='Nonexistent' isn't in the roster.
   Roster has: Bear, Arfy — pick one, or add 'Nonexistent' to …/.dridock/agents.yml." \
        _twh_run_session_start_hook "$stub_dir"
    if [ "$_TWH_RC" = 0 ] \
        && printf '%s' "$_TWH_STDOUT" | grep -q "team-bus OFF" \
        && printf '%s' "$_TWH_STDOUT" | grep -q "could not resolve your identity" \
        && printf '%s' "$_TWH_STDOUT" | grep -q "isn't in the roster"; then
        ok "case 3: bad DRIDOCK_AGENT_NAME (whoami rc=1) → loud exit 0, CLI suggestion surfaced"
    else
        bad "case 3: expected rc=0 + team-bus-OFF + identity + CLI suggestion; got rc=$_TWH_RC"
        printf '  stdout: %s\n' "$_TWH_STDOUT" | head -8
    fi

    # Case 4: roster present in parent, hook invoked from subdirectory.
    # The stub `dridock` returns rc=0 regardless of CWD, which faithfully
    # models the real CLI's git-toplevel-based ProjectRootResolver — so a
    # naive `[ -f .dridock/agents.yml ]` gate here would have silent-
    # exited (subdir has no .dridock/), whereas the actual gate defers to
    # the CLI and passes. Assert the gate does NOT silent-exit in this
    # shape (i.e. the hook proceeds past the gates and emits SOMETHING).
    #
    # We can't run to completion (no real fetcher spawn), so we check
    # that stdout is non-empty — meaning we reached Step 2/3 output.
    local subdir; subdir="$(mktemp -d)/some/deep/subdir"
    mkdir -p "$subdir"
    pushd "$subdir" >/dev/null
    _twh_run_session_start_hook "$stub_dir"
    popd >/dev/null
    if [ "$_TWH_RC" = 0 ] && [ -n "$_TWH_STDOUT" ]; then
        ok "case 4: roster-fine + subdirectory → gate does NOT silent-exit"
    else
        bad "case 4: expected rc=0 + non-empty stdout (past the gate); got rc=$_TWH_RC stdout_empty=$([ -z "$_TWH_STDOUT" ] && echo yes || echo no)"
    fi

    echo "--- $((PASS + FAIL)) checks, $PASS pass, $FAIL fail ---"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_team_watch_hooks_opt_in)

# Direct invocation → run standalone.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_team_watch_hooks_opt_in
fi

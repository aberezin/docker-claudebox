#!/usr/bin/env bash
# shellcheck disable=SC1090  # sources $_TSD_LIB, always inside a subshell
# #107 — socket delivery: the fetcher posts team-bus events straight into the
# agent's Claude session instead of the agent keeping a Monitor armed.
#
# The safety property under test: the wake file (the fetcher's "post here")
# exists ONLY while `crossSessionInbound: "accept"` is in force from a trusted
# source. Without accept the session HOLDS the fetcher's post, the socket
# can't say so, and the fetcher would advance the cursor past an event the
# agent never saw. So most of this file is the precedence table and the two
# hooks honouring it.
#
# Drives the real hooks and status line with a stub `dridock`, a stand-in
# fetcher, and a real listening Unix socket. TWH_ANCESTOR_PID=1 stops the
# --settings lookup from walking up to whatever Claude session runs the suite.
# Host-only: no Docker, no token.
#
# Self-registers into ALL_TESTS. Also directly runnable:
#   bash tests/test_team_socket_delivery.sh
set -u

_TSD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TSD_REPO="$_TSD_DIR/.."
_TSD_LIB="$_TSD_REPO/.claude/hooks/lib/team-inbox-watch.sh"
_TSD_SS="$_TSD_REPO/.claude/hooks/team-watch-session-start.sh"
_TSD_UPS="$_TSD_REPO/.claude/hooks/team-watch-user-prompt-submit.sh"
_TSD_SL="$_TSD_REPO/.claude/statusline-dridock.sh"

_tsd_stub_dridock() {
    mkdir -p "$1"
    cat > "$1/dridock" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
    "team roster")  exit 0 ;;
    "team whoami")  echo "Bear"; exit 0 ;;
    "team watch")   sleep 600 ;;  # stand-in fetcher; NOT exec (keeps the cmdline)
    *)              exit 0 ;;
esac
STUB
    chmod +x "$1/dridock"
}

# Precedence check in isolation. Args: managed flag user project local.
# Each settings arg is a crossSessionInbound value ("" = file absent); the
# flag is passed as inline JSON the way the entrypoint passes it.
_tsd_eff() {
    local d; d="$(mktemp -d)"
    local m="$d/m.json" u="$d/u.json" p="$d/p.json" l="$d/l.json" f=""
    [ -n "$1" ] && printf '{"crossSessionInbound":"%s"}' "$1" > "$m"
    [ -n "$2" ] && f="{\"crossSessionInbound\":\"$2\"}"
    [ -n "$3" ] && printf '{"crossSessionInbound":"%s"}' "$3" > "$u"
    [ -n "$4" ] && printf '{"crossSessionInbound":"%s"}' "$4" > "$p"
    [ -n "$5" ] && printf '{"crossSessionInbound":"%s"}' "$5" > "$l"
    ( . "$_TSD_LIB"; twh_effective_inbound "$m" "$f" "$u" "$p" "$l"; printf '%s' "$TWH_INBOUND" )
    rm -rf "$d"
}

# Managed tier with drop-ins. Args: managed-file-value dropin1 dropin2 flag.
# "" = absent. Drop-ins land in managed-settings.d/ beside the file.
_tsd_eff_dropin() {
    local d; d="$(mktemp -d)"
    local m="$d/managed-settings.json" f="" n=0 v
    mkdir -p "$d/managed-settings.d"
    [ -n "$1" ] && printf '{"crossSessionInbound":"%s"}' "$1" > "$m"
    for v in "$2" "$3"; do
        n=$((n + 1))
        [ -n "$v" ] && printf '{"crossSessionInbound":"%s"}' "$v" > "$d/managed-settings.d/$n-policy.json"
    done
    [ -n "$4" ] && f="{\"crossSessionInbound\":\"$4\"}"
    ( . "$_TSD_LIB"; twh_effective_inbound "$m" "$f" "$d/u" "$d/p" "$d/l"; printf '%s' "$TWH_INBOUND" )
    rm -rf "$d"
}

test_team_socket_delivery() {
    local PASS=0 FAIL=0
    ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
    bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
    expect_eff() { # want managed flag user project local — label
        local got; got="$(_tsd_eff "$2" "$3" "$4" "$5" "$6")"
        if [ "$got" = "$1" ]; then ok "precedence: $7 → $1"; else bad "precedence: $7 → want $1, got $got"; fi
    }

    echo "--- #107 socket delivery ---"
    if ! command -v jq >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
        bad "jq and python3 are required (JSON settings; a real listening socket)"
        echo "  #107 socket delivery: $PASS passed, $FAIL failed"; return 1
    fi

    # ── the precedence table (settings reference: managed → flag → user;
    #    project/local only ever make it stricter) ─────────────────────
    expect_eff unset  ""       ""      ""      ""      ""      "nothing set"
    expect_eff accept ""       ""      accept  ""      ""      "user accept"
    expect_eff unset  ""       ""      ""      accept  ""      "project accept alone is IGNORED"
    expect_eff unset  ""       ""      ""      ""      accept  "local accept alone is IGNORED"
    expect_eff hold   ""       ""      accept  hold    ""      "user accept + project hold"
    expect_eff refuse ""       ""      accept  ""      refuse  "user accept + local refuse"
    expect_eff accept ""       accept  hold    ""      ""      "--settings accept beats user hold"
    expect_eff hold   hold     accept  ""      ""      ""      "managed hold beats --settings accept"
    expect_eff refuse bogus    accept  accept  ""      ""      "unrecognized managed value refuses"
    expect_eff hold   ""       ""      bogus   ""      ""      "unrecognized user value holds"
    expect_eff hold   ""       accept  ""      ""      bogus   "unrecognized local value holds despite flag accept"

    # --settings given as a FILE path, not inline JSON
    local d; d="$(mktemp -d)"
    printf '{"crossSessionInbound":"accept"}' > "$d/flag.json"
    local got; got="$( . "$_TSD_LIB"; twh_effective_inbound "$d/none" "$d/flag.json" "$d/none" "$d/none" "$d/none"; printf '%s' "$TWH_INBOUND")"
    if [ "$got" = accept ]; then ok "--settings as a file path is read"; else bad "--settings file path: want accept, got $got"; fi
    rm -rf "$d"

    # managed-settings.d/ drop-ins (Arfy, #107 review): strictest managed value wins.
    expect_dropin() { # want file d1 d2 flag — label
        got="$(_tsd_eff_dropin "$2" "$3" "$4" "$5")"
        if [ "$got" = "$1" ]; then ok "managed drop-ins: $6 → $1"; else bad "managed drop-ins: $6 → want $1, got $got"; fi
    }
    expect_dropin hold   accept hold   ""     ""     "file accept + drop-in hold"
    expect_dropin refuse ""     refuse ""     accept "drop-in refuse beats --settings accept"
    expect_dropin refuse ""     hold   refuse ""     "two drop-ins: strictest (refuse) wins"
    expect_dropin refuse ""     bogus  ""     accept "unrecognized drop-in value refuses"
    expect_dropin accept ""     accept ""     ""     "drop-in accept alone is managed accept"

    # ── fixtures for the hook-level checks ────────────────────────────
    local stub xdg cfg proj inbox cursors sock spid="" fpid=""
    stub="$(mktemp -d)"; xdg="$(mktemp -d)"; cfg="$(mktemp -d)"; proj="$(mktemp -d)"
    _tsd_stub_dridock "$stub"
    mkdir -p "$xdg/dridock/inbox"
    inbox="$xdg/dridock/inbox/Bear.jsonl"
    cursors="$inbox.session-cursors.json"
    # Short path: sun_path is ~104 bytes on macOS and mktemp -d can be long.
    sock="$(mktemp -u /tmp/tsd.XXXXXX).sock"
    printf '{"e":1}\n' > "$inbox"
    printf '{"sess-A":%s}' "$(wc -c < "$inbox" | tr -d ' ')" > "$cursors"

    python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(); time.sleep(600)' "$sock" &
    spid=$!
    "$stub/dridock" team watch --inbox "$inbox" >/dev/null 2>&1 &
    fpid=$!; echo "$fpid" > "$inbox.pid"
    sleep 0.5
    if [ -S "$sock" ] && kill -0 "$fpid" 2>/dev/null; then
        ok "fixtures up: listening socket + stand-in fetcher (assertions below are not vacuous)"
    else
        bad "fixtures failed: socket=$( [ -S "$sock" ] && echo yes || echo no ) fetcher=$(kill -0 "$fpid" 2>/dev/null && echo alive || echo dead)"
    fi

    _tsd_cleanup() {
        [ -n "$spid" ] && kill "$spid" 2>/dev/null
        [ -n "$fpid" ] && kill "$fpid" 2>/dev/null
        rm -rf "$stub" "$xdg" "$cfg" "$proj" "$sock"
    }
    # Hook env: user settings in $cfg, project settings in $proj, no claude
    # ancestor, and this test's socket — never the runner's own.
    _tsd_hook() { # hook-script session-id [extra env…]
        local h="$1" sid="$2"; shift 2
        printf '{"session_id":"%s"}' "$sid" | env -u CLAUDE_CODE_MESSAGING_TOKEN \
            PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" CLAUDE_CONFIG_DIR="$cfg" \
            CLAUDE_PROJECT_DIR="$proj" TWH_ANCESTOR_PID=1 \
            CLAUDE_CODE_MESSAGING_SOCKET="$sock" "$@" bash "$h" 2>/dev/null
    }

    # ── SessionStart, no accept anywhere → no wake file, says why, Monitor ──
    local out
    out="$(_tsd_hook "$_TSD_SS" sess-A)"
    if [ ! -e "$inbox.wake.json" ]; then ok "SessionStart without accept: no wake file"; else bad "SessionStart without accept wrote a wake file"; fi
    case "$out" in *"socket delivery is OFF"*"not 'accept'"*) ok "…and says socket delivery is off and why" ;;
        *) bad "…expected an OFF + reason line, got: $(printf '%s' "$out" | tail -8)" ;; esac
    # The fix it names depends on whether the hook can read exact argv here.
    if [ -d /proc/self ]; then
        case "$out" in *"--settings '{\"crossSessionInbound\":\"accept\"}'"*) ok "…and names the --settings fix (host has /proc)" ;;
            *) bad "…the --settings fix is missing from the OFF note" ;; esac
    else
        case "$out" in *"user settings"*"can't be verified"*) ok "…and names user settings, not the unverifiable flag (no /proc)" ;;
            *) bad "…on a no-/proc host the OFF note must point at user settings" ;; esac
    fi
    case "$out" in *"tail -F -c +"*) ok "…and still prints the Monitor arm command" ;; *) bad "…Monitor arm command missing" ;; esac

    # ── accept only in PROJECT settings → still off (by design) ───────
    mkdir -p "$proj/.claude"; printf '{"crossSessionInbound":"accept"}' > "$proj/.claude/settings.json"
    _tsd_hook "$_TSD_SS" sess-A >/dev/null
    if [ ! -e "$inbox.wake.json" ]; then ok "project-settings accept does NOT enable socket delivery"; else bad "project-settings accept enabled socket delivery"; fi
    rm -f "$proj/.claude/settings.json"

    # ── accept in user settings → wake file, 600, right session; no Monitor ──
    printf '{"crossSessionInbound":"accept"}' > "$cfg/settings.json"
    out="$(_tsd_hook "$_TSD_SS" sess-A CLAUDE_CODE_MESSAGING_TOKEN=tok-1)"
    if [ -f "$inbox.wake.json" ]; then ok "SessionStart with user accept: wake file written"; else bad "SessionStart with user accept: no wake file"; fi
    local mode; mode="$(stat -c %a "$inbox.wake.json" 2>/dev/null || stat -f %Lp "$inbox.wake.json" 2>/dev/null)"
    if [ "$mode" = 600 ]; then ok "…mode 600 (it carries the session token)"; else bad "…mode is $mode, want 600"; fi
    if [ "$(jq -r '.sessionId + "|" + .socket + "|" + .token' "$inbox.wake.json" 2>/dev/null)" = "sess-A|$sock|tok-1" ]; then
        ok "…names this session, socket and token"; else bad "…wrong content: $(cat "$inbox.wake.json")"; fi
    case "$out" in *"SOCKET delivery is on"*) ok "…and tells the agent socket delivery is on" ;; *) bad "…no socket-on line" ;; esac
    case "$out" in *"tail -F -c +"*) bad "…but still prints a Monitor arm command (would double-deliver)" ;; *) ok "…and does NOT print a Monitor arm command" ;; esac

    # ── --settings accept on the launch line (the dridock entrypoint path) ──
    rm -f "$cfg/settings.json" "$inbox.wake.json"
    local fake; fake="$stub/claude"
    # A process named `claude` carrying --settings, as the hook's parent.
    cp "$(command -v bash)" "$fake"
    printf '{"session_id":"sess-A"}' > "$stub/payload"
    # The hook's parent is a process named `claude` whose argv carries
    # --settings; no TWH_ANCESTOR_PID, so the real ancestor walk runs.
    if env -u CLAUDE_CODE_MESSAGING_TOKEN -u TWH_ANCESTOR_PID PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" CLAUDE_CONFIG_DIR="$cfg" CLAUDE_PROJECT_DIR="$proj" \
        CLAUDE_CODE_MESSAGING_SOCKET="$sock" "$fake" -c 'bash "$1" < "$2" >/dev/null 2>&1; test -f "$3"' \
        x "$_TSD_SS" "$stub/payload" "$inbox.wake.json" --settings '{"crossSessionInbound":"accept"}'; then
        _tsd_flag_on=1
    else
        _tsd_flag_on=0
    fi
    # Platform-split BY DESIGN (Arfy, #107 re-review): the flag is a source
    # only where argv is exact (/proc). Pin both halves — the inverse is what
    # catches a regression back to reading the flag off `ps`.
    if [ -d /proc/self ]; then
        if [ "$_tsd_flag_on" = 1 ]; then ok "--settings accept on the claude launch line enables socket delivery (/proc host)"
        else bad "--settings accept on the claude launch line did NOT enable socket delivery (/proc host)"; fi
    else
        if [ "$_tsd_flag_on" = 0 ]; then ok "--settings accept on the launch line is IGNORED without exact argv (no /proc)"
        else bad "--settings accept was counted without /proc — the ps-flattened read is back (false-accept class)"; fi
    fi
    # Negative control: same launch, no --settings. Without it the pass above
    # could be the walk finding something else entirely.
    rm -f "$inbox.wake.json"
    env -u CLAUDE_CODE_MESSAGING_TOKEN -u TWH_ANCESTOR_PID PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" CLAUDE_CONFIG_DIR="$cfg" CLAUDE_PROJECT_DIR="$proj" \
        CLAUDE_CODE_MESSAGING_SOCKET="$sock" "$fake" -c 'bash "$1" < "$2" >/dev/null 2>&1' x "$_TSD_SS" "$stub/payload"
    if [ ! -e "$inbox.wake.json" ]; then ok "…and the same launch WITHOUT --settings does not (control)"
    else bad "control: no --settings, yet a wake file was written — the pass above proves nothing"; fi
    # Arfy's case A (#107 review): no real --settings, but another argument's
    # TEXT quotes one — exactly what --append-system-prompt carries once these
    # docs are in CLAUDE.md or a skill. Must NOT count as accept. On macOS the
    # flattened `ps` line made this a false accept; /proc argv is exact.
    rm -f "$inbox.wake.json"
    env -u CLAUDE_CODE_MESSAGING_TOKEN -u TWH_ANCESTOR_PID PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" CLAUDE_CONFIG_DIR="$cfg" CLAUDE_PROJECT_DIR="$proj" \
        CLAUDE_CODE_MESSAGING_SOCKET="$sock" "$fake" -c 'bash "$1" < "$2" >/dev/null 2>&1; :' x "$_TSD_SS" "$stub/payload" \
        --append-system-prompt "start it with claude --settings '{\"crossSessionInbound\":\"accept\"}' to enable"
    if [ ! -e "$inbox.wake.json" ]; then ok "flag text quoted inside --append-system-prompt does NOT count as accept"
    else bad "FALSE ACCEPT: prompt text quoting --settings enabled socket delivery (posts would be held, cursor advanced)"; fi
    # Case B: real --settings hold, prompt text quotes accept → still off.
    env -u CLAUDE_CODE_MESSAGING_TOKEN -u TWH_ANCESTOR_PID PATH="$stub:$PATH" XDG_CONFIG_HOME="$xdg" CLAUDE_CONFIG_DIR="$cfg" CLAUDE_PROJECT_DIR="$proj" \
        CLAUDE_CODE_MESSAGING_SOCKET="$sock" "$fake" -c 'bash "$1" < "$2" >/dev/null 2>&1; :' x "$_TSD_SS" "$stub/payload" \
        --settings '{"crossSessionInbound":"hold"}' --append-system-prompt "use --settings '{\"crossSessionInbound\":\"accept\"}'"
    if [ ! -e "$inbox.wake.json" ]; then ok "real --settings hold is not overridden by quoted accept text"
    else bad "quoted accept text overrode a real --settings hold"; fi

    # ── running fetcher too old to post (Arfy, #107 review) ───────────
    # The stand-in fetcher is a script, so /proc/<pid>/exe is bash and its
    # --version isn't semver: the gate falls through to the <inbox>.version
    # stamp, which these cases drive. (The /proc source itself was checked
    # against the real fetcher binary in-container; see the commit.)
    printf '{"crossSessionInbound":"accept"}' > "$cfg/settings.json"
    rm -f "$inbox.wake.json"; printf '5.13.0\n' > "$inbox.version"
    out="$(_tsd_hook "$_TSD_SS" sess-A)"
    if [ ! -e "$inbox.wake.json" ]; then ok "fetcher stamped 5.13.0 + accept → NO wake file (it can't post)"
    else bad "fetcher stamped 5.13.0 + accept → wake file written: false live·sock"; fi
    case "$out" in *"running 5.13.0"*"needs 5.14.0"*) ok "…and names both versions" ;; *) bad "…versions not named; got: $(printf '%s' "$out" | grep -i socket | head -2)" ;; esac
    case "$out" in *"tail -F -c +"*) ok "…and keeps the Monitor path" ;; *) bad "…and drops the Monitor arm command" ;; esac
    out="$(_tsd_hook "$_TSD_UPS" sess-A)"
    if [ ! -e "$inbox.wake.json" ]; then ok "UPS does not turn delivery on for a too-old fetcher"; else bad "UPS turned delivery on for a too-old fetcher"; fi
    # A wake file already there (written before the gate, or the fetcher was
    # respawned onto an older binary) is pulled by UPS, and the nag returns.
    printf '5.14.0\n' > "$inbox.version"
    _tsd_hook "$_TSD_SS" sess-A >/dev/null
    if [ -e "$inbox.wake.json" ]; then ok "fetcher stamped 5.14.0 + accept → wake file written"; else bad "fetcher stamped 5.14.0 + accept → no wake file"; fi
    printf '5.13.0\n' > "$inbox.version"
    out="$(_tsd_hook "$_TSD_UPS" sess-A)"
    if [ ! -e "$inbox.wake.json" ]; then ok "UPS pulls a wake file when the running fetcher is too old"; else bad "UPS kept a wake file in front of a too-old fetcher"; fi
    case "$out" in *"socket delivery OFF"*"running 5.13.0"*) ok "…and says so, with the version" ;; *) bad "…silently" ;; esac
    # Unstamped / unreadable → fail OPEN (absent is not "too old").
    rm -f "$inbox.version"
    _tsd_hook "$_TSD_SS" sess-A >/dev/null
    if [ -e "$inbox.wake.json" ]; then ok "no version readable → fail open (wake file written)"; else bad "no version readable → socket delivery turned off (must fail open)"; fi
    rm -f "$inbox.wake.json"

    # ── UPS: socket live, nothing new → no Monitor nag ────────────────
    printf '{"crossSessionInbound":"accept"}' > "$cfg/settings.json"
    _tsd_hook "$_TSD_SS" sess-A >/dev/null
    out="$(_tsd_hook "$_TSD_UPS" sess-A)"
    case "$out" in *"NOT armed"*) bad "UPS nags about the Monitor while socket delivery is live" ;;
        *) ok "UPS: socket live + nothing new → no Monitor nag" ;; esac

    # ── UPS: an event the socket post missed is drained in-line, no re-arm ──
    printf '{"e":2,"missed":true}\n' >> "$inbox"
    out="$(_tsd_hook "$_TSD_UPS" sess-A)"
    case "$out" in *'"missed":true'*"end delta"*) ok "UPS: event past the cursor is drained in-line" ;;
        *) bad "UPS: missed event not drained; got: $(printf '%s' "$out" | tail -6)" ;; esac
    case "$out" in *"socket post did not deliver"*) ok "…labelled as a missed socket post" ;; *) bad "…not labelled as a socket miss" ;; esac
    case "$out" in *"re-arm your Monitor"*) bad "…but asks to re-arm a Monitor" ;; *) ok "…without asking to re-arm a Monitor" ;; esac

    # ── status line shows live·sock ───────────────────────────────────
    out="$(printf '{"cwd":"%s","session_id":"sess-A"}' "$_TSD_REPO" \
        | DRIDOCK_AGENT_NAME=Bear XDG_CONFIG_HOME="$xdg" bash "$_TSD_SL" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')"
    case "$out" in *"📬 live·sock"*) ok "status line: 📬 live·sock" ;; *) bad "status line: want '📬 live·sock', got: $out" ;; esac
    out="$(printf '{"cwd":"%s","session_id":"other"}' "$_TSD_REPO" \
        | DRIDOCK_AGENT_NAME=Bear XDG_CONFIG_HOME="$xdg" bash "$_TSD_SL" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')"
    case "$out" in *"live·sock"*) bad "status line: a DIFFERENT session shows live·sock" ;; *) ok "status line: another session is not live·sock" ;; esac

    # ── accept withdrawn mid-session → UPS pulls the wake file, loudly ──
    printf '{"crossSessionInbound":"hold"}' > "$cfg/settings.json"
    out="$(_tsd_hook "$_TSD_UPS" sess-A)"
    if [ ! -e "$inbox.wake.json" ]; then ok "accept withdrawn → UPS removes the wake file"; else bad "accept withdrawn → wake file still there (fetcher would count held posts as delivered)"; fi
    case "$out" in *"socket delivery"*"turned OFF"*) ok "…and says so" ;; *) bad "…silently" ;; esac

    # …and the other direction: accept added mid-session, no wake file → UPS turns it on.
    printf '{"crossSessionInbound":"accept"}' > "$cfg/settings.json"
    out="$(_tsd_hook "$_TSD_UPS" sess-A)"
    if [ "$(jq -r .sessionId "$inbox.wake.json" 2>/dev/null)" = sess-A ]; then ok "accept added mid-session → UPS writes the wake file"
    else bad "accept added mid-session → no wake file (only SessionStart could turn it on)"; fi
    case "$out" in *"socket delivery turned ON"*) ok "…and says so" ;; *) bad "…silently" ;; esac
    # …but never takes a wake file that names another session.
    jq '.sessionId = "sess-OTHER"' "$inbox.wake.json" > "$inbox.wake.tmp" && mv "$inbox.wake.tmp" "$inbox.wake.json"
    _tsd_hook "$_TSD_UPS" sess-A >/dev/null
    if [ "$(jq -r .sessionId "$inbox.wake.json" 2>/dev/null)" = sess-OTHER ]; then ok "UPS leaves another session's wake file alone"
    else bad "UPS took over another session's wake file"; fi
    rm -f "$inbox.wake.json"

    # ── socket gone → not live (the status line and UPS agree) ────────
    printf '{"crossSessionInbound":"accept"}' > "$cfg/settings.json"
    _tsd_hook "$_TSD_SS" sess-A >/dev/null
    kill "$spid" 2>/dev/null; wait "$spid" 2>/dev/null; spid=""; rm -f "$sock"
    got="$( . "$_TSD_LIB"; twh_socket_live "$inbox" sess-A; printf '%s' "$TWH_SOCKET_LIVE")"
    if [ -z "$got" ]; then ok "socket file gone → not live"; else bad "socket file gone but reported live"; fi

    _tsd_cleanup
    echo "  #107 socket delivery: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_team_socket_delivery)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_team_socket_delivery
fi

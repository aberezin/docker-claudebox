#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #134: SessionStart must not spawn a second fetcher onto an inbox that already
# has one.
#
# WHY: every spawn decision in team-watch-session-start.sh came from the
# pidfile. `dridock team watch` keeps running when its pidfile write fails
# (TeamCommand.ts: "Continue anyway … Loud, not fatal", whose comment says it
# "breaks every liveness check the hooks do"), and a pidfile can be deleted by
# hand, so a live fetcher could be invisible — and the hook's answer to an
# invisible fetcher was to start another one. Two writers on one inbox, sharing
# one dedup cursor: the outcome team-watch-user-prompt-submit.sh:183 refuses by
# name on the path where it can see the pid. The header comment claimed a
# `pgrep` guard that did not exist.
#
# Extracts _find_fetcher_without_pidfile from the real hook and runs it with
# `pgrep`/`ps` stubbed on PATH. No processes are started: the dedup cursor under
# <xdg>/watch-cursors/ is shared and orthogonal to the inbox, so a real second
# watcher could advance past events the live fetcher hasn't delivered — the
# experiment would cost messages. Hence stubs.

_FND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_fetcher_no_duplicate() {
local REPO="$_FND_DIR/.."
local HOOK="$REPO/.claude/hooks/team-watch-session-start.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- team fetcher: no second writer on one inbox (#134) ---"

local tmp; tmp="$(mktemp -d)"
awk '/^_find_fetcher_without_pidfile\(\) \{/,/^\}/' "$HOOK" > "$tmp/find.sh"
if ! grep -q '_find_fetcher_without_pidfile()' "$tmp/find.sh"; then
    bad "couldn't extract _find_fetcher_without_pidfile from the hook: the cases below would test nothing"
    rm -rf "$tmp"; echo "  fetcher no-duplicate: $PASS passed, $FAIL failed"; return 1
fi

mkdir -p "$tmp/bin"
# Stubs. $STUB_PS is one "pid<TAB>command" line per process; pgrep prints the
# pids whose command matches its pattern, ps -p N -o command= prints that
# command — the same narrow-then-filter the real pair gives us.
cat > "$tmp/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
_pat="${*: -1}"
printf '%s\n' "$STUB_PS" | while IFS=$'\t' read -r _p _c; do
    [ -n "$_p" ] || continue
    case "$_c" in *"$_pat"*) printf '%s\n' "$_p" ;; esac
done
exit 0
STUB
cat > "$tmp/bin/ps" <<'STUB'
#!/usr/bin/env bash
_want=""
while [ $# -gt 0 ]; do case "$1" in -p) _want="$2"; shift 2 ;; *) shift ;; esac; done
printf '%s\n' "$STUB_PS" | while IFS=$'\t' read -r _p _c; do
    [ "$_p" = "$_want" ] && printf '%s\n' "$_c"
done
exit 0
STUB
chmod +x "$tmp/bin/pgrep" "$tmp/bin/ps"

local INBOX="/Users/claude-arfy/.local/state/dridock/team/Arfy.inbox.jsonl"
local _out=""
# $1 = the stubbed process table, $2 = PATH prefix ('' to drop the stubs)
_find() {
    _out="$(PATH="${2-$tmp/bin}:$PATH" STUB_PS="$1" \
        bash -c ". '$tmp/find.sh'; _find_fetcher_without_pidfile '$INBOX'" 2>/dev/null)"
}

# 1. The case the issue is about: a live fetcher, no pidfile to find it by.
_find "4242	dridock team watch --inbox $INBOX"
[ "$_out" = "4242" ] && ok "a live fetcher on this inbox is found without its pidfile" \
    || bad "expected pid 4242, got '$_out'"

# 2. The false positive that would be WORSE than the bug: this hook's own
#    catch-up run. Reading it as a live fetcher skips the spawn and leaves
#    delivery dead with no error at all.
_find "4243	dridock team watch --once --inbox $INBOX"
[ -z "$_out" ] && ok "a --once catch-up run is NOT mistaken for a live fetcher" \
    || bad "--once matched as a fetcher (pid '$_out'): the spawn would be skipped and delivery would stop"

# 3. The other agent's fetcher, in a container sharing this host.
_find "4244	dridock team watch --inbox /home/claude/.local/state/dridock/team/Bear.inbox.jsonl"
[ -z "$_out" ] && ok "a fetcher on a DIFFERENT inbox is not ours" || bad "another inbox matched: '$_out'"

# 4. A decoy that merely mentions the command — a wrapper, or a diagnostic.
#    twh_find_tail's lesson (#105): Arfy reproduced a non-tail decoy reading as
#    live, and the consequence there was silent loss.
_find "4245	bash -c nohup dridock team watch --inbox $INBOX"
[ -z "$_out" ] && ok "a bash -c wrapper quoting the command is not the fetcher" || bad "decoy matched: '$_out'"

# 5. An absolute path to the binary is still the binary.
_find "4246	/usr/local/bin/dridock team watch --inbox $INBOX"
[ "$_out" = "4246" ] && ok "an absolute argv[0] still counts" || bad "absolute path missed: '$_out'"

# 6. Nothing running: empty, not an error.
_find "4247	some-other-process --inbox $INBOX"
[ -z "$_out" ] && ok "an unrelated process is not a fetcher" || bad "unrelated matched: '$_out'"

# 7. No pgrep on PATH: rc 0 and no answer, so the caller keeps the pidfile's
#    verdict rather than acting on a failed look.
mkdir -p "$tmp/empty"
# "$BASH", not `bash`: a PATH assignment on a simple command applies to the
# command search as well, so `PATH=<no-bash-here> bash -c` fails with
# "bash: command not found" and the case passes for the wrong reason.
_out="$(PATH="$tmp/empty" STUB_PS="" "$BASH" -c ". '$tmp/find.sh'; _find_fetcher_without_pidfile '$INBOX'; echo \"rc=\$?\"" 2>/dev/null)"
[ "$_out" = "rc=0" ] && ok "no pgrep: no answer and rc 0, never a false 'nothing is running'" \
    || bad "no-pgrep path returned '$_out'"

# 8. Structural: the spawn block must consult the finder BEFORE spawning, or
#    the function above is dead code.
local _guard _spawn
_guard="$(grep -n '_find_fetcher_without_pidfile "\$_inbox"' "$HOOK" | head -1 | cut -d: -f1)"
_spawn="$(grep -n 'nohup dridock team watch' "$HOOK" | head -1 | cut -d: -f1)"
if [ -n "$_guard" ] && [ -n "$_spawn" ] && [ "$_guard" -lt "$_spawn" ]; then
    ok "the spawn path consults the finder first (line $_guard before $_spawn)"
else
    bad "the finder is not consulted before the spawn (guard='$_guard' spawn='$_spawn')"
fi

# 9. And the header comment no longer promises a guard that isn't there.
if grep -q "the next SessionStart's \`pgrep\`" "$HOOK"; then
    bad "the header still claims a pgrep check the implementation doesn't do"
else
    ok "the header describes the mechanism the code actually has"
fi

rm -rf "$tmp"
echo "  fetcher no-duplicate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_fetcher_no_duplicate)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    ALL_TESTS=()
    test_fetcher_no_duplicate
fi

#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #128: a refused `--continue` is no longer silently replaced by a fresh session.
#
# WHY: entrypoint.sh ran `claude --continue … || exec claude …`. On 2026-11-16 a
# recreated container's `--continue` was REFUSED ("moved to a background session
# … registered from another machine or container"), and the fallback started a
# fresh session whose TUI cleared the refusal off the screen, so a 99 MB
# conversation looked lost. With nothing to continue, `--continue` exits 0
# (CLI 2.1.319 and 2.1.326), so the fallback only ever hid real failures.
#
# Takes the interactive command string straight out of entrypoint.sh and runs it
# under `bash -c` with a stub `claude`, so it needs no image and no API.

_CNF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_continue_no_fallback() {
local REPO="$_CNF_DIR/.."
local EP="$REPO/entrypoint.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- entrypoint: no silent fresh-session fallback for --continue (#128) ---"

# 1. Structural: no `|| exec claude` anywhere (both launch paths had one).
# Code only: the comments explaining the removal quote the old shape.
local hits; hits="$(grep -n '|| exec claude' "$EP" | grep -vE '^[0-9]+:[[:space:]]*#')"
if [ -n "$hits" ]; then
    bad "entrypoint.sh still has a '|| exec claude' fallback: $(printf '%s' "$hits" | head -2 | tr '\n' ' ')"
else
    ok "no '|| exec claude' fallback left in entrypoint.sh"
fi

# 2. Behaviour of the interactive command, with a stub claude that records each
#    invocation and exits with $STUB_RC.
# The $CMD below is literal text to find, not an expansion.
local line
# shellcheck disable=SC2016
line="$(grep -n 'CMD="\$CMD && { claude --dangerously-skip-permissions --continue' "$EP" | head -1 | cut -d: -f1)"
if [ -z "$line" ]; then
    bad "couldn't find the interactive --continue command in entrypoint.sh: the cases below would test nothing"
    echo "  continue no-fallback: $PASS passed, $FAIL failed"; return 1
fi
local tmp; tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/claude" <<'STUB'
#!/usr/bin/env bash
echo "claude $*" >> "$STUB_LOG"
exit "${STUB_RC:-0}"
STUB
chmod 755 "$tmp/bin/claude"
local assign; assign="$(sed -n "${line}p" "$EP" | sed 's/^[[:space:]]*//')"
build() {
    # Read by the eval'd assignment below.
    # shellcheck disable=SC2034
    local CMD="true" SYSTEM_HINT_FLAG="" INTERACTIVE_EXTRA="'--remote-control'" _RESUME_HINT="dridock start --resume 0c5e5f31-test-sid"
    eval "$assign"
    printf '%s' "$CMD"
}
local cmd; cmd="$(build)"
runit() {   # $1 = rc the stub returns; sets out, rc, calls
    : > "$tmp/log"
    out="$(STUB_RC="$1" STUB_LOG="$tmp/log" PATH="$tmp/bin:$PATH" bash -c "$cmd" 2>&1)"; rc=$?
    calls="$(wc -l < "$tmp/log" | tr -d ' ')"
}
local out rc calls

runit 0
[ "$rc" -eq 0 ] && [ "$calls" -eq 1 ] && [ -z "$out" ] && grep -q -- '--continue' "$tmp/log" \
    && ok "rc 0 (normal exit, or nothing to continue): one run, with --continue, nothing printed" \
    || bad "rc 0 case: rc=$rc calls=$calls out=$out"

runit 1
if [ "$rc" -eq 1 ] && [ "$calls" -eq 1 ] && [[ "$out" == *"dridock start --resume 0c5e5f31-test-sid"* ]]; then
    ok "refused (rc 1): NOT followed by a fresh run, rc kept, and the way back is printed with the id"
else
    bad "refusal case: rc=$rc calls=$calls out=$out"
fi

local k
for k in 130 137 143; do
    runit "$k"
    [ "$rc" -eq "$k" ] && [ "$calls" -eq 1 ] && [ -z "$out" ] \
        && ok "rc $k (Ctrl-C / killed / SIGTERM): exit kept, no misleading hint" || bad "rc $k case: rc=$rc calls=$calls out=$out"
done

# 3. The helpers, taken from entrypoint.sh: --resume is judged on argv
#    elements, and the hint names the newest session for the workspace.
awk '/^\t_has_resume\(\) \{/,/^\t\}/' "$EP" > "$tmp/fns.sh"
awk '/^\t_last_session_id\(\) \{/,/^\t\}/' "$EP" | sed "s#/home/claude/.claude#$tmp/c#g" >> "$tmp/fns.sh"
if ! grep -q '_has_resume()' "$tmp/fns.sh" || ! grep -q '_last_session_id()' "$tmp/fns.sh"; then
    bad "couldn't extract _has_resume/_last_session_id from entrypoint.sh"
else
    # shellcheck disable=SC1091
    . "$tmp/fns.sh"
    _has_resume "'--resume' 'abc'" && _has_resume "'--resume=abc'" && _has_resume "'--remote-control' '--resume' 'x'" \
        && ok "--resume (separate or =value, anywhere in the args) skips --continue" \
        || bad "--resume not detected"
    ! _has_resume "'--remote-control'" && ! _has_resume "'--resumex'" \
        && ! _has_resume "'--append-system-prompt' 'prefer --resume over restarting'" \
        && ok "--remote-control, --resumex, and --resume inside a VALUE don't count" \
        || bad "false --resume match"
    # Read by the sourced _last_session_id.
    # shellcheck disable=SC2034
    local WORKSPACE_DIR="/u/my_proj.v2" d
    d="$tmp/c/projects/-u-my-proj-v2"
    mkdir -p "$d"
    [ -z "$(_last_session_id)" ] && ok "no transcripts → no id (the hint falls back to the placeholder)" || bad "id from an empty dir"
    : > "$d/old-1111.jsonl"; touch -d '2 hours ago' "$d/old-1111.jsonl"; : > "$d/new-2222.jsonl"
    [ "$(_last_session_id)" = "new-2222" ] && ok "the newest transcript's id, under Claude's slug for the path" || bad "wrong id: '$(_last_session_id)'"
fi

# 4. The stale-registration prune (proven on 2026-11-17: with a dead
#    container's `kind: bg` entry present, --continue picked an older
#    conversation; with it removed, the right one).
awk '/^\t_prune_foreign_cli_sessions\(\) \{/,/^\t\}/' "$EP" > "$tmp/prune.sh"
if ! grep -q '_prune_foreign_cli_sessions()' "$tmp/prune.sh"; then
    bad "couldn't extract _prune_foreign_cli_sessions from entrypoint.sh"
else
    local S="$tmp/sessions" MINE="linux:aaaa:pid:[1]" OTHER="linux:bbbb:pid:[1]"
    mkdir -p "$S"
    printf '{"pid":11,"sessionId":"dead-bg","entrypoint":"cli","kind":"bg","pidDomain":"%s"}' "$OTHER" > "$S/11.json"
    : > "$S/11.abc.key"
    # Our domain, LIVE pid (this test shell): a running session, kept.
    printf '{"pid":%s,"sessionId":"live-me","entrypoint":"cli","kind":"interactive","pidDomain":"%s"}' "$$" "$MINE" > "$S/12.json"
    : > "$S/12.def.key"
    # Our domain, DEAD pid: an earlier run of this container (a `docker start`
    # restart keeps the machine-id and gets the same pid-ns inode), removed.
    printf '{"pid":999999,"sessionId":"dead-me","entrypoint":"cli","kind":"bg","pidDomain":"%s"}' "$MINE" > "$S/15.json"
    : > "$S/15.ghi.key"
    printf '{"pid":13,"sessionId":"sibling-p","entrypoint":"sdk-cli","kind":"interactive","pidDomain":"%s"}' "$OTHER" > "$S/13.json"
    printf 'not json' > "$S/14.json"
    out="$(bash -c ". '$tmp/prune.sh'; _prune_foreign_cli_sessions '$S' '$MINE'" 2>&1)"
    [ ! -e "$S/11.json" ] && [ ! -e "$S/11.abc.key" ] && [[ "$out" == *"session dead-bg left by a container from another image"* ]] \
        && ok "a dead container's cli entry (and its .key) is removed, and named on stderr" \
        || bad "foreign cli entry not pruned as expected: $(ls "$S") / $out"
    [ -e "$S/12.json" ] && [ -e "$S/12.def.key" ] && ok "our domain with a LIVE pid is kept" || bad "live own entry removed"
    [ ! -e "$S/15.json" ] && [ ! -e "$S/15.ghi.key" ] && [[ "$out" == *"session dead-me left by an earlier run (pid 999999 is gone)"* ]] \
        && ok "our domain with a DEAD pid (an earlier run, same machine-id + pid ns) is removed, said as such" \
        || bad "dead own-domain entry not pruned: $(ls "$S") / $out"
    [ -e "$S/13.json" ] && ok "a foreign sdk-cli (-p) entry is kept: it may be a live sibling" || bad "sdk-cli entry removed"
    [ -e "$S/14.json" ] && ok "an unreadable entry is left alone" || bad "malformed entry removed"
    [ "$(printf '%s' "$out" | grep -c 'removed a stale')" -eq 2 ] && ok "exactly two removals reported" || bad "removal lines: $out"
fi
# LOAD-BEARING tie: the prune is safe only while one data dir has one
# interactive container, which #123's copy refusal enforces. If that refusal
# is ever removed, this fails, and the prune has to be reconsidered with it.
if grep -q "looks like a COPY" "$REPO/dridock-ts/src/services/AdoptionService.ts" 2>/dev/null; then  # swallow-ok: a missing file is a FAIL below
    ok "#123's copy refusal still exists (the prune's one-interactive-container invariant)"
else
    bad "AdoptionService no longer refuses a copied project: the #128 prune may now delete a LIVE sibling's registration"
fi

rm -rf "$tmp"
echo "  continue no-fallback: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_continue_no_fallback)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_continue_no_fallback
fi

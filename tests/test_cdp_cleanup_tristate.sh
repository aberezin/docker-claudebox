#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #131: `cb-browser script-cdp` cleanup must never diff against a "before" it
# doesn't have.
#
# WHY: cleanup closes the tabs a script leaked by diffing the debug Chrome's
# page list before and after the run. Both reads were
#   _pre="$(curl … | (jq … || true))" || _pre=""
# so a 3s timeout, a briefly unreachable bridge or a jq parse error all stored
# the same "" that an empty page list stores. Cleanup then counted EVERY page in
# _post as "opened by this script" and closed it: the human's own tabs in the
# debug-profile Chrome, and the about:blank warm-up tab _cdp_ensure_page had
# just created — which also makes the NEXT connectOverCDP fail with
# "Browser.setDownloadBehavior: not supported". One value meant two things:
# "no tabs before" and "couldn't tell". Same shape as #123's listContainers
# returning [] for both "none" and "couldn't ask".
#
# Runs the REAL cb-browser with `curl` and `docker` stubbed on PATH, so the
# trap, the diff and the messages are the shipped ones. No bridge, no Chrome,
# no container.

_CDP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_cdp_cleanup_tristate() {
local REPO="$_CDP_DIR/.."
local CB="$REPO/cb-browser"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- cb-browser script-cdp: cleanup never guesses a 'before' (#131) ---"

if [ ! -f "$CB" ]; then
    bad "cb-browser not found at $CB: every case below would test nothing"
    echo "  cdp cleanup tri-state: $PASS passed, $FAIL failed"; return 1
fi

local tmp; tmp="$(mktemp -d)"
mkdir -p "$tmp/bin"

# Stub curl. $STUB_LIST_PLAN is one response per /json/list call, in order,
# '|'-separated; FAIL means a non-zero exit (unreachable / timeout). Closes and
# /json/new calls are appended to $STUB_LOG.
cat > "$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
_url=""
for _a in "$@"; do case "$_a" in http*) _url="$_a" ;; esac; done
case "$_url" in
  */json/list)
    _n=$(( $(cat "$STUB_STATE" 2>/dev/null || printf 0) + 1 ))
    printf '%s' "$_n" > "$STUB_STATE"
    echo "list $_n" >> "$STUB_LOG"
    _resp="$(printf '%s' "$STUB_LIST_PLAN" | awk -F'[|]' -v i="$_n" '{print $i}')"
    [ "$_resp" = "FAIL" ] && exit 1
    printf '%s' "$_resp"
    ;;
  */json/close/*) echo "close ${_url##*/}" >> "$STUB_LOG" ;;
  */json/new*)    echo "new" >> "$STUB_LOG" ;;
esac
exit 0
STUB
# Stub docker: the Playwright sub-container is not what's under test.
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker" >> "$STUB_LOG"
exit 0
STUB
chmod +x "$tmp/bin/curl" "$tmp/bin/docker"
printf '// no-op\n' > "$tmp/script.cjs"

local PAGE_A='[{"type":"page","id":"AAA"}]'
local PAGE_AB='[{"type":"page","id":"AAA"},{"type":"page","id":"BBB"}]'
local PAGE_NONE='[]'
# A worker-only answer: valid JSON, zero PAGE targets. Not "unreachable".
local WORKERS='[{"type":"service_worker","id":"WWW"}]'

local _err="" _closes=0
# $1 = the /json/list plan (ensure_page | pre | post). CB_BROWSER_CDP_KEEP from $2.
_run() {
    : > "$tmp/log"; : > "$tmp/state"
    ( cd "$tmp" && PATH="$tmp/bin:$PATH" \
        STUB_LOG="$tmp/log" STUB_STATE="$tmp/state" STUB_LIST_PLAN="$1" \
        CB_BROWSER_OUT="$tmp/out" DRIDOCK_HOST_CDP_URL="http://cdp.test:9223" \
        CB_BROWSER_CDP_KEEP="${2:-0}" \
        bash "$CB" script-cdp "$tmp/script.cjs" ) >/dev/null 2>"$tmp/err"
    _err="$(cat "$tmp/err")"
    _closes="$(grep -c '^close ' "$tmp/log" || true)"; _closes="${_closes:-0}"
}

# 1. The reported bug: the "before" read fails, the "after" read works.
_run "$PAGE_A|FAIL|$PAGE_AB"
[ "$_closes" -eq 0 ] && [[ "$_err" == *"couldn't list the tabs open BEFORE the run"* ]] \
    && ok "a failed 'before' read closes NOTHING and says why (#131)" \
    || bad "pre unreachable: closed $_closes tab(s), stderr: $_err"

# 2. The half the inner `|| true` hid: curl succeeds, jq can't parse it.
_run "$PAGE_A|not json at all|$PAGE_AB"
[ "$_closes" -eq 0 ] && [[ "$_err" == *"couldn't list the tabs open BEFORE the run"* ]] \
    && ok "an unparseable 'before' read closes NOTHING either (jq's rc, not just curl's)" \
    || bad "pre unparseable: closed $_closes tab(s), stderr: $_err"

# 3. The feature still works: one tab appeared during the run, one gets closed.
_run "$PAGE_A|$PAGE_A|$PAGE_AB"
[ "$_closes" -eq 1 ] && grep -q '^close BBB$' "$tmp/log" && [[ "$_err" == *"closed 1 leaked page tab(s)"* ]] \
    && ok "a tab opened during the run is still closed, and only that one" \
    || bad "happy path: closed $_closes tab(s), log: $(tr '\n' ' ' < "$tmp/log")"

# 4. A tab that was already open before the run is never closed.
_run "$PAGE_AB|$PAGE_AB|$PAGE_AB"
[ "$_closes" -eq 0 ] && ok "tabs that were already open are left alone" \
    || bad "pre-existing tabs: closed $_closes tab(s)"

# 5. The 'after' read failing is not a licence to close either.
_run "$PAGE_A|$PAGE_A|FAIL"
[ "$_closes" -eq 0 ] && [[ "$_err" == *"CDP bridge unreachable"* ]] \
    && ok "a failed 'after' read closes nothing and names the bridge" \
    || bad "post unreachable: closed $_closes tab(s), stderr: $_err"

# 6. The bridge ANSWERING with no page targets is not "unreachable" (#131: that
#    branch used to diagnose an empty list as a dead bridge).
_run "$PAGE_A|$PAGE_A|$PAGE_NONE"
[ "$_closes" -eq 0 ] && [[ "$_err" != *"unreachable"* ]] \
    && ok "zero page targets after the run is silent, not 'bridge unreachable'" \
    || bad "post empty: closed $_closes tab(s), stderr: $_err"

# 7. Same, for an answer that has targets but no PAGE targets.
_run "$PAGE_A|$PAGE_A|$WORKERS"
[ "$_closes" -eq 0 ] && [[ "$_err" != *"unreachable"* ]] \
    && ok "a non-page-target-only answer is not 'bridge unreachable' either" \
    || bad "post workers-only: closed $_closes tab(s), stderr: $_err"

# 8. The opt-out still short-circuits everything.
_run "$PAGE_A|$PAGE_A|$PAGE_AB" 1
[ "$_closes" -eq 0 ] && [[ "$_err" == *"CB_BROWSER_CDP_KEEP=1"* ]] \
    && ok "CB_BROWSER_CDP_KEEP=1 still skips cleanup entirely" \
    || bad "KEEP=1: closed $_closes tab(s), stderr: $_err"

# 9. Structural: ONE reader of /json/list, so a second copy of the pipeline
#    can't reintroduce the collapse somewhere the cases above don't reach.
local reads n
reads="$(grep -n 'json/list' "$CB" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
n="$(printf '%s' "$reads" | grep -c . || true)"; n="${n:-0}"
if [ "$n" -eq 1 ] && [[ "$reads" == *'_json="$(curl'* ]]; then
    ok "exactly one /json/list read in the file, inside _cdp_page_ids"
else
    bad "expected one /json/list read (in _cdp_page_ids), found $n: $(printf '%s' "$reads" | head -3 | tr '\n' ' ')"
fi

# 10. And the collapse itself — a failed read assigned the empty string — is
#     gone. It is the defect, and it reads as harmless housekeeping.
local collapse; collapse="$(grep -nE '\|\|[[:space:]]*_(pre|post|pages)=""' "$CB" || true)"
[ -z "$collapse" ] && ok "no '|| _x=\"\"' left: a failed read no longer becomes an empty list" \
    || bad "the empty-string collapse is back: $(printf '%s' "$collapse" | head -2 | tr '\n' ' ')"

rm -rf "$tmp"
echo "  cdp cleanup tri-state: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_cdp_cleanup_tristate)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    ALL_TESTS=()
    test_cdp_cleanup_tristate
fi

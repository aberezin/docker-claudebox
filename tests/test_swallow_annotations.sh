#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# The self-test fixtures are shell source as literal text, hence single quotes.
# shellcheck disable=SC2015,SC2016
# #129: every shell `||` that DISCARDS a failure must say why that's safe.
#
# WHY: #128 was `claude --continue … || exec claude …`. One `||` turned a refusal
# the user had to act on into a silent fresh session. That is the "never silently
# discard user state" class (#17, #30, #31, #32), and `||` is the easiest way to
# write it in shell. This makes each new one state its reason.
#
# A line needs `# swallow-ok: <reason>` (trailing, or on the line just above)
# when it has any of:
#   || true    || :    || return 0    || exit 0    || exec …
#   || echo / || printf (a silent value or message substitution)
#   2>/dev/null and || on the same line, unless the line opens an if/elif/while
#   condition, or the || propagates the failure (`|| return 1`, `|| exit 2`,
#   `|| return "$rc"`): a branch or a propagation, not a discard (Arfy, #131)
# Branching forms (`|| {`, `|| continue`, `|| <assignment>`) aren't swallowing
# and aren't gated; the #129 audit checks them by hand. A bare `# swallow-ok`
# with no reason fails.
#
# The gate checks that a reason was WRITTEN, not that it is TRUE. #128's
# fallback would pass with "# swallow-ok: falls back to a fresh session". The
# audit table on #129 is what classifies; this only holds the line.
#
# WHAT IT CAN'T SEE: the patterns are ||-keyed, so `x="$(cmd 2>/dev/null)"`,
# the same "empty" vs "couldn't tell" collapse with no || at all, passes
# untouched. #131 (cb-browser _pre) and entrypoint.sh's resolv.conf backup
# (#129 review) were both that shape. Keep a read's rc when an empty result
# would drive a write or a delete.
#
# RATCHET: only files in SWEPT are gated. A group is added once its sites are
# classified and annotated (entrypoint.sh in a commit of its own). Pure grep: no
# image, no docker, no token.

_SA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Files gated so far, relative to the repo root.
SWALLOW_SWEPT=(
    cb-browser cb-consult cb-df cb-harness-watch-consults cb-help cb-host-shim cb-report-bug
    features/go/on.sh features/go/off.sh features/go/check.sh
    features/modeguard/on.sh features/modeguard/off.sh features/modeguard/check.sh
    features/python/on.sh features/python/off.sh features/python/check.sh
    features/typescript/on.sh features/typescript/off.sh features/typescript/check.sh
    features/web-scaffolders/on.sh features/web-scaffolders/off.sh features/web-scaffolders/check.sh
    install.sh .githooks/install.sh .githooks/pre-commit test.sh run-e2e-cron-telegram.sh
    .claude/hooks/consult-session-start.sh .claude/hooks/githooks-session-start.sh
    .claude/hooks/lib/team-inbox-watch.sh .claude/hooks/team-watch-session-end.sh
    .claude/hooks/team-watch-session-start.sh .claude/hooks/team-watch-user-prompt-submit.sh
    .claude/statusline-dridock.sh dridock claudebox-shell.sh
    entrypoint.sh
)

# Echo the pattern name a line needs annotating for, or nothing. Comment-only
# lines are skipped: comments may quote the forms.
_swallow_pattern() {
    local l="$1"
    [[ "$l" =~ ^[[:space:]]*# ]] && return 0
    local code="${l%%# swallow-ok*}"
    if   [[ "$code" =~ \|\|[[:space:]]*true([[:space:];\)\"]|$) ]]; then echo "|| true"
    elif [[ "$code" =~ \|\|[[:space:]]*:([[:space:];\)\"]|$) ]];    then echo "|| :"
    elif [[ "$code" =~ \|\|[[:space:]]*return[[:space:]]+0([[:space:];\)]|$) ]]; then echo "|| return 0"
    elif [[ "$code" =~ \|\|[[:space:]]*exit[[:space:]]+0([[:space:];\)]|$) ]];   then echo "|| exit 0"
    elif [[ "$code" =~ \|\|[[:space:]]*exec[[:space:]] ]]; then echo "|| exec"
    elif [[ "$code" =~ \|\|[[:space:]]*(echo|printf)([[:space:]]|$) ]]; then echo "|| echo/printf"
    elif [[ "$code" == *"2>/dev/null"* && "$code" == *"||"* ]] \
         && ! [[ "$code" =~ ^[[:space:]]*(if|elif|while)[[:space:]] ]] \
         && ! [[ "$code" =~ \|\|[[:space:]]*(return|exit)[[:space:]]+([1-9][0-9]*|\"?\$[A-Za-z_?][A-Za-z0-9_]*\"?)([[:space:];\)]|$) ]]; then
        echo "2>/dev/null ... ||"
    fi
}

# 0 if this line (or the one above) carries a swallow-ok with a reason.
_swallow_annotated() {
    local l="$1" prev="$2" re='#[[:space:]]*swallow-ok:[[:space:]]*[^[:space:]]'
    [[ "$l" =~ $re ]] && return 0
    [[ "$prev" =~ ^[[:space:]]*#.*swallow-ok:[[:space:]]*[^[:space:]] ]] && return 0
    return 1
}

# Print `file:line: <pattern>` for each unannotated hit in one file; rc 1 if any.
_swallow_scan() {
    local f="$1" n=0 prev="" line pat bad=0
    while IFS= read -r line || [ -n "$line" ]; do
        n=$((n + 1))
        pat="$(_swallow_pattern "$line")"
        if [ -n "$pat" ] && ! _swallow_annotated "$line" "$prev"; then
            echo "$f:$n: $pat"; bad=1
        fi
        prev="$line"
    done < "$f"
    return "$bad"
}

test_swallow_annotations() {
local REPO="$_SA_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- every error-discarding || in swept shell states why (#129) ---"

# Self-test first: a regex that silently matches nothing would pass everything.
local s
for s in 'x || true' 'x || :' 'f() { [ -d d ] || return 0; }' '[ -n "$a" ] || exit 0' \
         'claude --continue || exec claude' 'v=$(cmd 2>/dev/null || echo none)' 'x || true)' \
         'v="$(cmd | sort)" || echo "(none)"' "x || printf '%s' fallback" 'y=$(a 2>/dev/null || b)' ; do
    [ -n "$(_swallow_pattern "$s")" ] && ok "self-test: flags  $s" || bad "self-test: MISSED  $s"
done
for s in 'x || { echo no >&2; exit 1; }' '[ -f "$f" ] || continue' 'x || _n=$((_n+1))' \
         '# comment quoting || true' 'echo "a || b"' 'x || true_name' \
         'if ! mkdir -p "$D" 2>/dev/null || [ ! -w "$D" ]; then' 'x || echoes_name' \
         'j="$(curl -sf u 2>/dev/null)" || return 1' 'cmd 2>/dev/null || exit 2' 'x 2>/dev/null || return "$rc"' ; do
    [ -z "$(_swallow_pattern "$s")" ] && ok "self-test: ignores  $s" || bad "self-test: wrongly flags  $s"
done
_swallow_annotated 'x || true  # swallow-ok: no file is the normal case' '' && ok "self-test: trailing reason accepted" || bad "self-test: trailing reason rejected"
_swallow_annotated 'x || true' '    # swallow-ok: reason on the line above' && ok "self-test: reason on the line above accepted" || bad "self-test: line-above reason rejected"
! _swallow_annotated 'x || true  # swallow-ok' '' && ! _swallow_annotated 'x || true  # swallow-ok:   ' '' \
    && ok "self-test: a bare swallow-ok (no reason) is rejected" || bad "self-test: bare swallow-ok accepted"

# The gate itself.
local f out l
for f in "${SWALLOW_SWEPT[@]}"; do
    if [ ! -f "$REPO/$f" ]; then bad "$f is in SWALLOW_SWEPT but doesn't exist"; continue; fi
    if out="$(_swallow_scan "$REPO/$f")"; then
        ok "$f: every discarding || carries a reason"
    else
        bad "$f has unannotated discards:"
        while IFS= read -r l; do echo "         ${l#"$REPO"/}"; done <<<"$out"
    fi
done

echo "  swallow annotations: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_swallow_annotations)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_swallow_annotations
fi

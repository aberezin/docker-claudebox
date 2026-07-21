#!/usr/bin/env bash
# Standalone behavioral tests for the 3.x env-var rename compat shim (#16).
# Exercises:
#   1. The shared map file (env-rename.map at repo root): parses cleanly, every
#      pair is two valid shell identifiers, critical container-only pairs are
#      present (regression guard for the leak in #16).
#   2. The container-side aliaser (_dridock_alias_env in entrypoint.sh): the
#      function itself, source-and-invoked against a scratch map — asserts the
#      symmetric mirror semantics claimed by docs/design/env-var-rename.md.
#
# No docker required — pure bash. Runs under test.sh alongside the other unit
# tests. Guards against a future rename slipping through without a map entry,
# or the aliaser's symmetric semantics silently changing.
#
# Standalone runner: sourced by test.sh's tests/test_*.sh glob → return early
# so we don't leak `set -u`/traps into the caller's shell.
[ "${BASH_SOURCE[0]}" != "${0}" ] && return 0 2>/dev/null

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR/.."
MAP="$REPO/env-rename.map"
ENTRYP="$REPO/entrypoint.sh"

PASS=0
FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

echo "--- env-rename.map: file exists + is readable ---"
if [ -r "$MAP" ]; then ok "map file present at $MAP"
else bad "map file missing at $MAP"; echo "  $PASS passed, $FAIL failed"; exit 1; fi

echo "--- env-rename.map: every non-comment line is exactly two identifiers ---"
_bad_lines=0 _pair_count=0
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    set -- $line   # word-split on whitespace
    if [ $# -ne 2 ]; then
        echo "    offending line ($#): $line" >&2; _bad_lines=$((_bad_lines + 1)); continue
    fi
    _pair_count=$((_pair_count + 1))
    case "$1" in *[!A-Za-z0-9_]*|'') echo "    bad NEW id: $1" >&2; _bad_lines=$((_bad_lines + 1)) ;; esac
    case "$2" in *[!A-Za-z0-9_]*|'') echo "    bad LEGACY id: $2" >&2; _bad_lines=$((_bad_lines + 1)) ;; esac
done < "$MAP"
eq "every line parses as (NEW, LEGACY) shell ids" "$_bad_lines" "0"
if [ "$_pair_count" -ge 30 ]; then ok "map has ~all the renamed pairs (${_pair_count} >= 30)"
else bad "map has only ${_pair_count} pairs — likely truncated"; fi

echo "--- env-rename.map: coverage — critical container-only pairs present ---"
# These are the ones whose absence caused #16's cb-browser bug (and would cause
# the equivalent for cb-consult, cb-report-bug, cb-host-shim). Regression guard.
for _pair in \
    "DRIDOCK_HOST_CDP_URL CLAUDEBOX_HOST_CDP_URL" \
    "DRIDOCK_VM_IP CLAUDEBOX_VM_IP" \
    "DRIDOCK_PROJECT_ID CLAUDEBOX_PROJECT_ID" \
    "DRIDOCK_CONSULT_DIR CLAUDEBOX_CONSULT_DIR" \
    "DRIDOCK_FRAMEWORK_BUGS_DIR CLAUDEBOX_FRAMEWORK_BUGS_DIR" \
    "DRIDOCK_HOST_AGENT_URL CLAUDEBOX_HOST_AGENT_URL" \
    "DRIDOCK_HOST_AGENT_TOKEN CLAUDEBOX_HOST_AGENT_TOKEN"; do
    _new="${_pair%% *}"; _leg="${_pair##* }"
    if grep -qE "^[[:space:]]*${_new}[[:space:]]+${_leg}([[:space:]]|\$)" "$MAP"; then
        ok "pair present: $_pair"
    else
        bad "pair MISSING: $_pair (baked cb-* helper reading legacy will silently fail)"
    fi
done

echo "--- _dridock_alias_env behavior (extracted from entrypoint.sh) ---"
# Extract the function body from entrypoint.sh and source it here. Point it at
# a scratch map so tests don't depend on system paths.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/map" <<'MAP'
# comment lines ignored
DRIDOCK_TEST_A CLAUDEBOX_TEST_A
DRIDOCK_TEST_B CLAUDEBOX_TEST_B
DRIDOCK_TEST_C CLAUDEBOX_TEST_C
MAP

# Grab the function definition + rewrite the hardcoded map path. Fragile-by-design
# — a refactor of the function's shape (rename, split, move) requires updating
# this extraction. That's fine; the test is a spec of the current shape.
awk '/^_dridock_alias_env\(\)/,/^\}$/' "$ENTRYP" > "$TMP/fn.sh"
if [ ! -s "$TMP/fn.sh" ]; then bad "could not extract _dridock_alias_env from entrypoint.sh"; echo "  $PASS passed, $FAIL failed"; exit 1; fi
sed -i "s|/usr/local/lib/dridock/env-rename.map|$TMP/map|" "$TMP/fn.sh"

# Case 1: DRIDOCK_X set only → CLAUDEBOX_X mirrored
bash -c "source '$TMP/fn.sh'; export DRIDOCK_TEST_A=alpha; _dridock_alias_env; printf '%s' \"\${CLAUDEBOX_TEST_A:-<unset>}\"" > "$TMP/out"
eq "DRIDOCK_X alone -> CLAUDEBOX_X mirrored" "$(cat "$TMP/out")" "alpha"

# Case 2: CLAUDEBOX_X set only → DRIDOCK_X mirrored
bash -c "source '$TMP/fn.sh'; export CLAUDEBOX_TEST_B=bravo; _dridock_alias_env; printf '%s' \"\${DRIDOCK_TEST_B:-<unset>}\"" > "$TMP/out"
eq "CLAUDEBOX_X alone -> DRIDOCK_X mirrored" "$(cat "$TMP/out")" "bravo"

# Case 3: BOTH set → neither is clobbered
bash -c "source '$TMP/fn.sh'; export DRIDOCK_TEST_C=canonical CLAUDEBOX_TEST_C=legacy; _dridock_alias_env; printf '%s|%s' \"\$DRIDOCK_TEST_C\" \"\$CLAUDEBOX_TEST_C\"" > "$TMP/out"
eq "both set -> both preserved" "$(cat "$TMP/out")" "canonical|legacy"

# Case 4: Neither set → both stay unset (empty)
bash -c "source '$TMP/fn.sh'; unset DRIDOCK_TEST_A CLAUDEBOX_TEST_A DRIDOCK_TEST_B CLAUDEBOX_TEST_B DRIDOCK_TEST_C CLAUDEBOX_TEST_C; _dridock_alias_env; printf '%s|%s' \"\${DRIDOCK_TEST_A:-U}\" \"\${CLAUDEBOX_TEST_A:-U}\"" > "$TMP/out"
eq "neither set -> both stay unset" "$(cat "$TMP/out")" "U|U"

# Case 5: Missing map file → silent no-op (best-effort semantics)
rm -f "$TMP/map"
bash -c "source '$TMP/fn.sh'; export DRIDOCK_TEST_A=xyz; _dridock_alias_env; printf '%s' \"\${CLAUDEBOX_TEST_A:-<unset>}\"" > "$TMP/out" 2> "$TMP/err"
eq "missing map -> no aliasing, no error" "$(cat "$TMP/out")" "<unset>"
eq "missing map -> no stderr noise" "$(wc -c < "$TMP/err" | tr -d ' ')" "0"

# ── LINT: cb-* helpers must not read a bare ${CLAUDEBOX_X:-…} without a sibling
# ${DRIDOCK_X:-${CLAUDEBOX_X:-…}} fallback. The entrypoint shim covers this at
# runtime during 3.x, but every helper edited between now and 4.0 must migrate
# so the shim's removal in 4.0 doesn't strand it. This lint is the forcing
# function: any new bare-legacy read fails the build immediately.
#
# Positive shape:  ${DRIDOCK_X:-${CLAUDEBOX_X:-…}}
# Positive shape:  -e CLAUDEBOX_X=…       (docker -e passing to sub-container — legit)
# Rejected shape:  ${CLAUDEBOX_X:-…}      (bare legacy read; migrate to DRIDOCK_-first)
echo "--- lint: cb-* helpers must not have bare \${CLAUDEBOX_X:-…} reads ---"
_lint_offenders=0
for _cb in "$REPO"/cb-*; do
    # Skip if not a regular file (e.g. broken symlink)
    [ -f "$_cb" ] || continue
    # Find every ${CLAUDEBOX_X read, then filter: the preceding context on the
    # same line must be either ${DRIDOCK_X:- (sibling fallback) or -e (docker env
    # passthrough). Anything else is a bare read that needs migration.
    while IFS= read -r _hit; do
        # grep -n on a single file emits "LINENO:CONTENT" — strip once for each.
        _lineno="${_hit%%:*}"
        _line="${_hit#*:}"
        # Positive: a ${DRIDOCK_ appears on the same line BEFORE the ${CLAUDEBOX_
        # (the fallback shape). Awk splits and compares indices.
        _has_sibling=$(printf '%s' "$_line" | awk '
            { d = index($0, "${DRIDOCK_"); c = index($0, "${CLAUDEBOX_");
              print (d > 0 && d < c) ? "yes" : "no" }')
        # Positive: `-e CLAUDEBOX_X=…` docker env passthrough (legit — sub-container's
        # own scripts might read the legacy name; we pass both in cb-browser).
        _is_docker_e=$(printf '%s' "$_line" | grep -qE -- '-e CLAUDEBOX_' && echo yes || echo no)
        if [ "$_has_sibling" != yes ] && [ "$_is_docker_e" != yes ]; then
            echo "    $(basename "$_cb"):${_lineno}: bare \${CLAUDEBOX_ read — migrate to \${DRIDOCK_X:-\${CLAUDEBOX_X:-…}}" >&2
            _lint_offenders=$((_lint_offenders + 1))
        fi
    done < <(grep -nE '\$\{CLAUDEBOX_[A-Z_]+' "$_cb")
done
eq "no bare \${CLAUDEBOX_X:-} reads in cb-* helpers" "$_lint_offenders" "0"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

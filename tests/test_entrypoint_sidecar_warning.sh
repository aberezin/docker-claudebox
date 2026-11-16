#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #123: when a container's expected -auth / -secrets sidecar is missing but the
# same kind exists under ANOTHER container name, the entrypoint says so instead
# of starting with no credentials and nothing on stderr.
#
# WHY: DRIDOCK_CONTAINER_NAME is fixed at `docker run`. A container renamed, or
# left over from before 6.0's naming, looks for its sidecars under a name the
# wrapper no longer writes, and `_load_env_sidecar` returned 0 on a missing file.
#
# Extracts `_warn_missing_sidecar` from the real entrypoint.sh and runs it
# against a fixture dir, so it needs no image.

_ESW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_entrypoint_sidecar_warning() {
local REPO="$_ESW_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- entrypoint: a missing -auth/-secrets under a stale name is reported (#123) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
awk '/^_warn_missing_sidecar\(\) \{/,/^\}/' "$REPO/entrypoint.sh" | sed "s#/home/claude/.claude#$tmp/c#g" > "$fn"
if ! grep -q '^_warn_missing_sidecar() {' "$fn"; then
    bad "couldn't extract _warn_missing_sidecar from entrypoint.sh: the test would test nothing"
    rm -rf "$tmp"; echo "  sidecar warning: $PASS passed, $FAIL failed"; return 1
fi
mkdir -p "$tmp/c"
w() { CLAUDE_CONTAINER_NAME="$1" bash -c "source '$fn'; _warn_missing_sidecar '$2' '$tmp/c/.$1-$2'" 2>&1; }

local out
out="$(w claude-_old_path secrets)"
[ -z "$out" ] && ok "no sidecars of that kind anywhere → silent (a project without secrets)" || bad "warned with nothing to point at: $out"

echo "GH_TOKEN=x" > "$tmp/c/.claude-myproj-abc-secrets"
out="$(w claude-_old_path secrets)"
if [[ "$out" == *".claude-_old_path-secrets, which doesn't exist"* ]] && [[ "$out" == *".claude-myproj-abc-secrets does"* ]] \
   && [[ "$out" == *"dridock down && dridock start"* ]]; then
    ok "expected -secrets missing, another name's present → names both and the fix"
else
    bad "stale-name -secrets not reported: $out"
fi

echo "x" > "$tmp/c/.claude-myproj-abc-auth"; echo "x" > "$tmp/c/.claude-myproj-abc_cron-auth"
out="$(w claude-_old_path auth)"
[[ "$out" == *"(and 1 more)"* ]] && ok "-auth too, and counts the extra matches" || bad "auth case: $out"

echo "x" > "$tmp/c/.claude-myproj-abc-env"
out="$(w claude-_old_path env)"
[ -z "$out" ] && ok "other kinds (env, cdp, …) stay quiet: they're legitimately optional" || bad "warned for -env: $out"

# The container whose sidecar IS there never reaches this function, but if it
# did with only its own file present, it must not report itself.
rm -f "$tmp/c/".claude-*; echo x > "$tmp/c/.claude-myproj-abc-secrets"
out="$(w claude-myproj-abc secrets)"
[ -z "$out" ] && ok "its own file is not counted as 'another name'" || bad "reported itself: $out"

rm -rf "$tmp"
echo "  sidecar warning: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_entrypoint_sidecar_warning)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_entrypoint_sidecar_warning
fi

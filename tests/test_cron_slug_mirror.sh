#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #133: cron.py's slugify() and WorkspaceMoveReporter's cronHistorySlug() must
# agree, or the host looks for orphaned cron history in a directory that never
# existed — finds nothing, reports nothing, and the check silently does nothing.
#
# WHY A TEST AND NOT A COMMENT: the two rules are genuinely different from
# Claude's own session slug (runs of non-alphanumerics collapse to ONE `_` and
# are stripped from both ends, vs one `-` per character), so the mirror is easy
# to "fix" into agreement with the wrong one. This runs BOTH implementations
# over the same inputs and diffs them, rather than pinning a regex literal that
# a rewrite could satisfy while changing behaviour.
#
# slugify() is extracted from cron.py rather than imported: importing cron.py
# pulls `yaml` at module scope, which a bare host doesn't have (see CLAUDE.md
# on the Python tests).

_CSM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_cron_slug_mirror() {
local REPO="$_CSM_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- cron slug: cron.py and the TS mirror agree (#133) ---"

# Skipping is said out loud, never silent: a quiet skip is how a mirror test
# stops being a mirror test.
if ! command -v python3 >/dev/null 2>&1 || ! command -v bun >/dev/null 2>&1; then
    echo "  SKIP cron slug mirror: needs python3 and bun (have python3=$(command -v python3 || echo no), bun=$(command -v bun || echo no))"
    echo "  cron slug mirror: 0 passed, 0 failed (skipped)"
    return 0
fi

local tmp; tmp="$(mktemp -d)"
# The inputs that matter: a real rename pair, the container default, repeated
# and leading/trailing separators, dots and existing underscores, and the
# nothing-alphanumeric case that hits cron.py's "workspace" fallback.
local -a inputs=(
    "/Users/alan/Development/foo-claudebox"
    "/Users/alan/Development/foo-dridock"
    "/workspace" "/p" "/old" "/a//b" "/-/" "" "/u/my.proj-2" "/tmp/x_y" "/x/" "//"
)

# Python side, from cron.py's own source.
local fn; fn="$(awk '/^def slugify\(/,/^$/' "$REPO/cron.py")"
if ! printf '%s' "$fn" | grep -q 'def slugify'; then
    bad "couldn't extract slugify() from cron.py — the comparison below would test nothing"
    rm -rf "$tmp"; echo "  cron slug mirror: $PASS passed, $FAIL failed"; return 1
fi
{ echo "import re, sys"; printf '%s\n' "$fn"; echo 'for a in sys.argv[1:]: print(slugify(a))'; } > "$tmp/slug.py"
python3 "$tmp/slug.py" "${inputs[@]}" > "$tmp/py.out" 2>"$tmp/py.err" || {
    bad "python3 couldn't run cron.py's slugify: $(head -1 "$tmp/py.err")"
    rm -rf "$tmp"; echo "  cron slug mirror: $PASS passed, $FAIL failed"; return 1
}

# TS side, importing the real module.
cat > "$tmp/slug.ts" <<'TS'
import { cronHistorySlug } from "./dridock-ts/src/services/WorkspaceMoveReporter.ts";
for (const a of Bun.argv.slice(2)) console.log(cronHistorySlug(a));
TS
cp "$tmp/slug.ts" "$REPO/.cron-slug-probe.ts"
(cd "$REPO" && bun ./.cron-slug-probe.ts "${inputs[@]}") > "$tmp/ts.out" 2>"$tmp/ts.err" || {
    bad "bun couldn't run cronHistorySlug: $(head -1 "$tmp/ts.err")"
    rm -f "$REPO/.cron-slug-probe.ts"; rm -rf "$tmp"
    echo "  cron slug mirror: $PASS passed, $FAIL failed"; return 1
}
rm -f "$REPO/.cron-slug-probe.ts"

if diff -q "$tmp/py.out" "$tmp/ts.out" >/dev/null 2>&1; then
    ok "all ${#inputs[@]} inputs slug identically in cron.py and cronHistorySlug"
else
    bad "the two slug rules disagree:$(printf '\n'; paste -d'|' "$tmp/py.out" "$tmp/ts.out" | awk -F'|' '$1!=$2 {print "        py=["$1"] ts=["$2"]"}')"
fi

# A run of separators must collapse, not map one-for-one: this is the exact
# difference from Claude's session slug, and getting it wrong is the failure
# this file exists to catch.
[ "$(grep -c '^a_b$' "$tmp/py.out")" = "1" ] && ok "a run of separators collapses to one _ (not one per character)" \
    || bad "/a//b did not slug to a_b: $(sed -n '6p' "$tmp/py.out")"

rm -rf "$tmp"
echo "  cron slug mirror: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_cron_slug_mirror)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    ALL_TESTS=()
    test_cron_slug_mirror
fi

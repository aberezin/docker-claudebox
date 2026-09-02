#!/usr/bin/env bash
# Every doc under docs/ must appear in docs/README.md, and every link in that
# index must resolve.
#
# WHY: adding a doc and indexing it are separate steps, and nothing forced the
# second. On 2026-09-02 an audit found six docs missing from the index — two of
# them written that same day by the person running the audit. An unindexed doc
# is findable only by someone who already knows it exists, which is the opposite
# of what a doc is for.
#
# Same reasoning as tests/test_deprecation_deadlines.sh: a rule nobody can
# forget beats a rule everybody means to keep.
#
# No docker required — pure filesystem.

_DI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_docs_index() {
local REPO="$_DI_DIR/.."
local INDEX="$REPO/docs/README.md"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

echo "--- docs index conformance ---"

if [ ! -f "$INDEX" ]; then
    bad "docs/README.md missing — there is no index to conform to"
    echo "  docs index: $PASS passed, $FAIL failed"; return 1
fi

# 1. every doc is listed
local missing=0 total=0 rel
while IFS= read -r f; do
    rel="${f#"$REPO"/docs/}"
    [ "$rel" = "README.md" ] && continue
    total=$((total + 1))
    # Match on basename: the index links relative to docs/, so a path prefix
    # would make this brittle for no gain.
    grep -q "$(basename "$rel")" "$INDEX" || {
        echo "    docs/$rel is not listed in docs/README.md" >&2
        missing=$((missing + 1))
    }
done < <(find "$REPO/docs" -name '*.md' -type f | sort)

if [ "$missing" -eq 0 ]; then
    ok "all $total docs are listed in the index"
else
    bad "$missing of $total docs are missing from docs/README.md"
fi

# 2. every relative link in the index resolves. A listing that points at a
#    moved or deleted file is worse than no listing — it reads as evidence the
#    thing exists.
local dead=0 links=0 l
while IFS= read -r l; do
    links=$((links + 1))
    [ -f "$REPO/docs/$l" ] || { echo "    dead link in index: $l" >&2; dead=$((dead + 1)); }
done < <(grep -oE '\]\(([a-zA-Z0-9._/-]+\.md)\)' "$INDEX" | sed 's/](//;s/)//' | grep -v '^\.\./' | sort -u)

if [ "$dead" -eq 0 ]; then
    ok "all $links index links resolve"
else
    bad "$dead of $links index links are dead"
fi

echo "  docs index: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_docs_index)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_docs_index
fi

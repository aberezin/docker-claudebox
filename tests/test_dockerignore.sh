#!/usr/bin/env bash
# .dockerignore must keep `.bun-build` strays out of the build context,
# wherever they are. NOTE: this covers READABLE strays only. It creates them
# with `touch` (mode 644), and an unreadable (mode-000) stray fails the build on
# macOS before any pattern applies (Arfy, #114). install.sh's
# install_clear_unreadable handles those; tests/test_install_unreadable_guard.sh
# tests it. A stray in dridock-ts/ slipped past a root-only
# `*.bun-build` and failed ./install.sh with "failed to xattr … permission
# denied" (2026-11-12; framework-bug report 69adc719-2026-08-17T19-51-08).
#
# Uses the real docker client: it builds a throwaway context carrying THIS
# repo's .dockerignore, exports the result with `-o type=local`, and checks no
# .bun-build file came through. Matching rules are docker's, so a pattern read
# by eye is no substitute. Skips (and says so) when no docker daemon answers.

_DI2_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_dockerignore() {
local REPO="$_DI2_DIR/.."
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- .dockerignore keeps .bun-build strays and host build outputs out of the context ---"

if ! docker info >/dev/null 2>&1; then
    echo "  SKIP no docker daemon reachable — not verified"
    return 0
fi

local tmp; tmp="$(mktemp -d)"
mkdir -p "$tmp/ctx/dridock-ts/deep"
cp "$REPO/.dockerignore" "$tmp/ctx/.dockerignore"
printf 'FROM scratch\nCOPY . /ctx\n' > "$tmp/ctx/Dockerfile"
touch "$tmp/ctx/top.bun-build" \
      "$tmp/ctx/dridock-ts/.d0334600dafd3bdc-00000000.bun-build" \
      "$tmp/ctx/dridock-ts/deep/.x-00000000.bun-build" \
      "$tmp/ctx/dridock-ts/keep.ts"
# #145: the host's dridock-ts build outputs, the shapes install.sh leaves.
mkdir -p "$tmp/ctx/dridock-ts/bin" "$tmp/ctx/dridock-ts/node_modules/typescript/bin" "$tmp/ctx/dridock-ts/src"
touch "$tmp/ctx/dridock-ts/bin/dridock" "$tmp/ctx/dridock-ts/bin/dridock.map" \
      "$tmp/ctx/dridock-ts/node_modules/typescript/bin/tsc" \
      "$tmp/ctx/dridock-ts/package.json" "$tmp/ctx/dridock-ts/bun.lock" \
      "$tmp/ctx/dridock-ts/tsconfig.json" "$tmp/ctx/dridock-ts/src/main.ts"

if ! docker build -q -o "type=local,dest=$tmp/out" "$tmp/ctx" >/dev/null 2>&1; then
    bad "the probe build itself failed"
else
    local leaked
    leaked="$(cd "$tmp/out" && find . -name '*.bun-build')"
    if [ -z "$leaked" ]; then
        ok "no .bun-build file reaches the context, at the root or nested"
    else
        bad "leaked into the build context: $(echo "$leaked" | tr '\n' ' ')"
    fi
    # Guard against a pattern so broad it hides the source next to the stray.
    if [ -f "$tmp/out/ctx/dridock-ts/keep.ts" ]; then
        ok "ordinary files beside the strays are still included"
    else
        bad "dridock-ts/keep.ts was excluded too"
    fi
    # #145: the Mac's compiled binary and node_modules stay out; what the
    # Dockerfile's dridock-ts-build stage reads stays in.
    leaked="$(cd "$tmp/out/ctx/dridock-ts" && find bin node_modules -type f 2>/dev/null)"
    if [ -z "$leaked" ]; then
        ok "dridock-ts/bin and dridock-ts/node_modules (the host's build outputs) don't reach the context (#145)"
    else
        bad "host build outputs leaked into the context: $(echo "$leaked" | tr '\n' ' ')"
    fi
    local f missing=""
    for f in package.json bun.lock tsconfig.json src/main.ts; do
        [ -f "$tmp/out/ctx/dridock-ts/$f" ] || missing+=" $f"
    done
    [ -z "$missing" ] && ok "the files the dridock-ts-build stage COPYs are still included" \
        || bad "excluded but the Dockerfile needs them:$missing"
fi

rm -rf "$tmp"
echo "  dockerignore: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_dockerignore)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_dockerignore
fi

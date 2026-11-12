#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms; the
# single-quoted grep patterns are literal lines of install.sh.
# shellcheck disable=SC2015,SC2016
# #114: an unreadable file anywhere in the checkout fails the docker build on
# macOS ("failed to xattr …: permission denied"), whatever .dockerignore says.
# install.sh's install_clear_unreadable removes known temp shapes (named) and
# stops, without deleting, on any other unreadable file.
#
# Runs the real function, extracted between its markers, against a fixture
# tree. The strays are mode 000, which is the property that caused the break;
# a `touch`ed (644) stray would pass for the wrong reason, which is how
# tests/test_dockerignore.sh missed it. No docker required. Must run as a
# non-root user: root reads mode-000 files, but the predicate checks the mode,
# so the result is the same either way.

_UG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_install_unreadable_guard() {
local INSTALL="$_UG_DIR/../install.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- install.sh: unreadable files are cleared or named before the build (#114) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> install_clear_unreadable/,/^# <<< install_clear_unreadable/p' "$INSTALL" > "$fn"
if ! grep -q '^install_clear_unreadable()' "$fn"; then
    bad "function block not found between the markers in install.sh"
    rm -rf "$tmp"; echo "  install unreadable guard: $PASS passed, $FAIL failed"; return 1
fi

# _ug <tree> → "rc=<n>" then stderr
_ug() { bash -c ". '$fn'; install_clear_unreadable '$1'; echo rc=\$?" 2>&1; }

local t out
# 1. clean tree: silent, rc 0. Includes a chmod-600 secrets file (owner-readable).
t="$tmp/clean"; mkdir -p "$t/.dridock" "$t/dridock-ts"
echo "K=V" > "$t/.dridock/secrets.env"; chmod 600 "$t/.dridock/secrets.env"
touch "$t/dridock-ts/keep.ts"
out="$(_ug "$t")"
[ "$out" = "rc=0" ] && ok "clean tree (with a chmod-600 secrets.env): silent, rc 0" || bad "clean tree: $out"

# 2. the incident: a mode-000 bun stray in dridock-ts/ is removed and named.
t="$tmp/stray"; mkdir -p "$t/dridock-ts/deep"
touch "$t/dridock-ts/.d0334600dafd3bdc-00000000.bun-build" "$t/dridock-ts/deep/.x-00000000.bun-build"
chmod 000 "$t/dridock-ts/.d0334600dafd3bdc-00000000.bun-build" "$t/dridock-ts/deep/.x-00000000.bun-build"
out="$(_ug "$t")"
if [ ! -e "$t/dridock-ts/.d0334600dafd3bdc-00000000.bun-build" ] && [ ! -e "$t/dridock-ts/deep/.x-00000000.bun-build" ] \
   && [ "$(printf '%s\n' "$out" | grep -c 'removed an unreadable bun build temp file')" = 2 ] && [ "${out##*$'\n'}" = "rc=0" ]; then
    ok "mode-000 .bun-build strays (nested too) are removed, each named, rc 0"
else
    bad "bun strays not cleared as expected; got: $out"
fi

# 3. an unreadable file we don't recognise: named, NOT deleted, rc 1.
t="$tmp/unknown"; mkdir -p "$t/sub"
echo data > "$t/sub/locked.txt"; chmod 000 "$t/sub/locked.txt"
out="$(_ug "$t")"
if [ -e "$t/sub/locked.txt" ]; then ok "an unrecognised unreadable file is not deleted"; else bad "deleted a file it didn't recognise"; fi
case "$out" in
    *"sub/locked.txt is unreadable"*"doesn't delete files it doesn't recognise"*"rc=1") ok "...and it's named, with rc 1" ;;
    *) bad "unrecognised unreadable file not reported as expected; got: $out" ;;
esac
chmod 644 "$t/sub/locked.txt"

# 4. .git is skipped (git's own files are git's business).
t="$tmp/git"; mkdir -p "$t/.git/objects"
touch "$t/.git/objects/odd"; chmod 000 "$t/.git/objects/odd"
out="$(_ug "$t")"
[ "$out" = "rc=0" ] && ok ".git is skipped" || bad ".git not skipped: $out"
chmod 644 "$t/.git/objects/odd"

# 5. install.sh calls it before the build and stops on failure.
local call build
call="$(grep -n '^if ! install_clear_unreadable "\$SCRIPT_DIR"; then$' "$INSTALL" | cut -d: -f1)"
build="$(grep -n '^install_build_variants "\$CB_INFRA_CTX"' "$INSTALL" | cut -d: -f1)"
if [ -n "$call" ] && [ -n "$build" ] && [ "$call" -lt "$build" ] \
   && sed -n "$((call + 1)),$((call + 3))p" "$INSTALL" | grep -q 'exit 1'; then
    ok "install.sh runs the guard before the image build and exits 1 if it fails"
else
    bad "install.sh doesn't gate the build on the guard (call line '${call}', build line '${build}')"
fi

chmod -R u+rw "$tmp" 2>/dev/null; rm -rf "$tmp"
echo "  install unreadable guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_install_unreadable_guard)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_install_unreadable_guard
fi

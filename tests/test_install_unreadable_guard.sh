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
# directories and another user's files are covered too (Arfy's #114 review);
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

# 3b. an unreadable DIRECTORY (Arfy, #114 review): fails the build the same way,
# and find can't descend, so a stray inside it is invisible. Named, not
# deleted, rc 1, and find's own error is reported rather than dropped.
t="$tmp/dir"; mkdir -p "$t/dridock-ts/hidden"
touch "$t/dridock-ts/hidden/.a-00000000.bun-build"; chmod 000 "$t/dridock-ts/hidden/.a-00000000.bun-build"
chmod 000 "$t/dridock-ts/hidden"
out="$(_ug "$t")"
case "$out" in
    *"dridock-ts/hidden is a directory"*"doesn't delete directories"*) ok "a mode-000 directory is named as a directory" ;;
    *) bad "mode-000 directory not reported; got: $out" ;;
esac
case "$out" in
    *"couldn't check everything"*"hidden"*"rc=1") ok "...find's error on it is reported, not swallowed, and rc is 1" ;;
    *) bad "find's error on the unreadable dir was dropped or rc wasn't 1; got: $out" ;;
esac
chmod 755 "$t/dridock-ts/hidden"
[ -e "$t/dridock-ts/hidden/.a-00000000.bun-build" ] && ok "...and nothing inside it was touched" || bad "the guard reached into an unreadable dir"
# a directory that can be listed but not entered (r without x) also fails the walk.
t="$tmp/noexec"; mkdir -p "$t/d"; touch "$t/d/f"; chmod 600 "$t/d"
out="$(_ug "$t")"
case "$out" in
    *"/d is a directory"*"rc=1") ok "a directory without x (can't enter) is named, rc 1" ;;
    *) bad "r-without-x directory not reported; got: $out" ;;
esac
chmod 755 "$t/d"

# 3c. readability, not a mode bit: a mode-600 file owned by ANOTHER user has
# u+r and is still unreadable to us. Needs passwordless sudo to set up; says
# so when it can't, rather than passing.
t="$tmp/foreign"; mkdir -p "$t"; echo x > "$t/root-owned"; chmod 600 "$t/root-owned"
if [ "$(id -u)" != 0 ] && sudo -n chown 0:0 "$t/root-owned" 2>/dev/null; then
    out="$(_ug "$t")"
    case "$out" in
        *"root-owned is unreadable"*"rc=1") ok "a mode-600 file owned by root is caught (u+r is set, but we can't read it)" ;;
        *) bad "another user's mode-600 file passed the guard; got: $out" ;;
    esac
    sudo -n rm -f "$t/root-owned"
else
    echo "  skip another-user's-600-file case: needs non-root with passwordless sudo (not a pass)"
fi

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

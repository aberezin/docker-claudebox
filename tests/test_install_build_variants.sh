#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms; the
# single-quoted grep pattern is a literal line of install.sh.
# shellcheck disable=SC2015,SC2016
# #111: install.sh builds BOTH image variants, the one dridock runs first. A
# failed primary build stops the install; a failed secondary build is reported
# at once and again at the end, and the install exits non-zero.
# DRIDOCK_SKIP_MINIMAL=1 opts out of the minimal build.
#
# Runs the real functions, extracted from install.sh between their markers,
# against a stub `docker` that logs each build and fails the target named in
# IB_FAIL. No docker required.

_IB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_install_build_variants() {
local INSTALL="$_IB_DIR/../install.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- install.sh: builds both image variants (#111) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> install_build_variants/,/^# <<< install_build_variants/p' "$INSTALL" > "$fn"
if ! grep -q '^install_build_variants()' "$fn" || ! grep -q '^install_variant_plan()' "$fn"; then
    bad "function block not found between the markers in install.sh"
    rm -rf "$tmp"; echo "  install build variants: $PASS passed, $FAIL failed"; return 1
fi

# Stub docker: logs "build <target> <tag> <all args>" and fails when the
# --target equals $IB_FAIL.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
target="" tag=""
while [ $# -gt 0 ]; do
    case "$1" in --target) target="$2"; shift ;; -t) tag="$2"; shift ;; esac
    shift
done
echo "build $target $tag" >> "$IB_LOG"
[ -n "${IB_FAIL:-}" ] && [ "$target" = "$IB_FAIL" ] && { echo "stub: build of $target failed" >&2; exit 7; }
exit 0
STUB
chmod +x "$tmp/bin/docker"

# _ib <DRIDOCK_MINIMAL> <DRIDOCK_SKIP_MINIMAL> <fail-target>
# → the build log, then "--stderr--", then stderr. (_rc below gives the rc.)
_ib() {
    local log="$tmp/log.$RANDOM"; : > "$log"
    local err="$tmp/err.$RANDOM"
    local res
    res="$( PATH="$tmp/bin:$PATH" IB_LOG="$log" IB_FAIL="$3" bash -c "
        . '$fn'
        install_variant_plan '$1' '$2' || { echo rc=plan-refused; exit 0; }
        install_build_variants colima-cb-infra dridock /src --build-arg DRIDOCK_VERSION=5.14.0
        echo \"rc=\$? failed=\$INSTALL_SECONDARY_FAILED\"
    " 2>"$err" >/dev/null; cat "$log" )"
    printf '%s\n' "$res"
    echo "--stderr--"; cat "$err"
}
# The rc/failed line: run again capturing only that line.
_rc() {
    PATH="$tmp/bin:$PATH" IB_LOG=/dev/null IB_FAIL="$3" bash -c "
        . '$fn'
        install_variant_plan '$1' '$2' || { echo plan-refused; exit 0; }
        install_build_variants colima-cb-infra dridock /src >/dev/null
        echo \"rc=\$? failed=\$INSTALL_SECONDARY_FAILED\"
    " 2>/dev/null | tail -1
}

local out
out="$(_ib '' '' '')"
case "$out" in
    "build full dridock:latest"$'\n'"build minimal dridock:latest-minimal"$'\n'"--stderr--"*)
        ok "default: builds full (the image dridock runs) then minimal" ;;
    *) bad "default build order wrong; got: $out" ;;
esac
[ "$(_rc '' '' '')" = "rc=0 failed=" ] && ok "default: rc 0, nothing failed" || bad "default rc: $(_rc '' '' '')"

out="$(_ib 1 '' '')"
case "$out" in
    "build minimal dridock:latest-minimal"$'\n'"build full dridock:latest"$'\n'"--stderr--"*)
        ok "DRIDOCK_MINIMAL=1: builds minimal first, then full — it no longer picks only one" ;;
    *) bad "DRIDOCK_MINIMAL=1 order wrong; got: $out" ;;
esac

out="$(_ib '' 1 '')"
case "$out" in
    "build full dridock:latest"$'\n'"--stderr--") ok "DRIDOCK_SKIP_MINIMAL=1: only the full image" ;;
    *) bad "skip flag didn't skip minimal; got: $out" ;;
esac

out="$(_ib 1 1 '')"
if [ "$(_rc 1 1 '')" = "plan-refused" ]; then
    case "$out" in
        *"DRIDOCK_SKIP_MINIMAL is set, but DRIDOCK_MINIMAL"*) ok "SKIP_MINIMAL with MINIMAL set: refused before any build, and says why" ;;
        *) bad "contradiction refused without the reason; got: $out" ;;
    esac
    case "$out" in *"build "*) bad "a build ran despite the refusal: $out" ;; esac
else
    bad "SKIP_MINIMAL + MINIMAL was not refused: $(_rc 1 1 '')"
fi

out="$(_ib '' maybe '')"
case "$out" in
    *"build minimal dridock:latest-minimal"*"isn't a recognised value"*) ok "unrecognised SKIP value: says so and builds minimal anyway" ;;
    *) bad "unrecognised skip value mishandled; got: $out" ;;
esac
[ "$(_rc '' 0 '')" = "rc=0 failed=" ] && [ "$(_ib '' 0 '' | grep -c '^build ')" = 2 ] && ok "SKIP_MINIMAL=0 builds both" || bad "SKIP_MINIMAL=0 skipped something"

# Secondary failure: reported now, rc 0 so the binary still installs, tag recorded.
out="$(_ib '' '' minimal)"
case "$out" in
    *"dridock:latest-minimal, failed to build (rc=7"*"Retry with: make build-minimal"*) ok "failed second build: named at once, with rc and retry command" ;;
    *) bad "failed second build not reported as expected; got: $out" ;;
esac
[ "$(_rc '' '' minimal)" = "rc=0 failed=dridock:latest-minimal" ] && ok "failed second build: install continues, tag recorded" || bad "secondary failure state: $(_rc '' '' minimal)"

# ...and the end-of-install verdict is non-zero and says so.
out="$( bash -c ". '$fn'; install_finish dridock:latest-minimal; echo rc=\$?" 2>&1 )"
case "$out" in
    *"INCOMPLETE"*"make build-minimal"*"rc=1") ok "install_finish: a failed second build makes the install exit non-zero" ;;
    *) bad "install_finish didn't fail loudly; got: $out" ;;
esac
out="$( bash -c ". '$fn'; install_finish ''; echo rc=\$?" 2>&1 )"
[ "$out" = "rc=0" ] && ok "install_finish: silent and rc 0 when both built" || bad "install_finish spoke or failed on success: $out"

# The install script really calls it before declaring success.
if grep -q '^install_finish "\$INSTALL_SECONDARY_FAILED" || exit 1$' "$INSTALL"; then
    ok "install.sh exits via install_finish before the success line"
else
    bad "install.sh doesn't call install_finish with exit 1"
fi

# Primary failure: rc 1, the secondary is never attempted.
out="$(_ib 1 '' minimal)"
case "$out" in
    "build minimal dridock:latest-minimal"$'\n'"--stderr--"*"install stops here"*) ok "failed primary build: stops, second build not attempted" ;;
    *) bad "primary failure handling wrong; got: $out" ;;
esac
[ "$(_rc 1 '' minimal)" = "rc=1 failed=" ] && ok "failed primary build: rc 1" || bad "primary failure rc: $(_rc 1 '' minimal)"

rm -rf "$tmp"
echo "  install build variants: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_install_build_variants)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_install_build_variants
fi

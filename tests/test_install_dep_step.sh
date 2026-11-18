#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms; the
# single-quoted grep patterns are literal lines of install.sh.
# shellcheck disable=SC2015,SC2016
# #132: install.sh's dependency step can fail the install, and the build can't
# hide a bad dependency tree.
#
# WHY: the three steps were one pipeline whose guard could only see the last
# rc, and a failed `bun install --frozen-lockfile` only printed a warning. Two
# measured facts made that guard decorative: `bun build` needs no node_modules
# at all (a complete working binary came out of a tree where it had never been
# installed), and nothing on the install path ran `tsc`, the only step that
# reads node_modules. So a lockfile failure scrolled past and `✅ setup
# complete` was printed over a binary that wasn't the one bun.lock describes —
# and #118 established that line gets read as "the change is live".
#
# Runs the real install_ts_wrapper, extracted from install.sh between its
# markers, against a stub `bun` that logs each step and fails the one named in
# BUN_FAIL. No bun, no node_modules, no docker.

_IDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_install_dep_step() {
local INSTALL="$_IDS_DIR/../install.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
echo "--- install.sh: the dependency step can fail the install (#132) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> install_ts_wrapper/,/^# <<< install_ts_wrapper/p' "$INSTALL" > "$fn"
if ! grep -q '^install_ts_wrapper()' "$fn"; then
    bad "install_ts_wrapper not found between the markers in install.sh: the cases below would test nothing"
    rm -rf "$tmp"; echo "  install dep step: $PASS passed, $FAIL failed"; return 1
fi

mkdir -p "$tmp/bin" "$tmp/ts"
cat > "$tmp/bin/bun" <<'STUB'
#!/usr/bin/env bash
step="unknown:$*"
case "$1 ${2:-}" in
    "install --frozen-lockfile") step=install ;;
    "run typecheck")            step=typecheck ;;
    "run build")                step=build ;;
esac
echo "$step" >> "$BUN_LOG"
if [ "${BUN_FAIL:-}" = "$step" ]; then
    echo "stub-bun: $step exploded (DISTINCTIVE-$step)" >&2
    exit 3
fi
exit 0
STUB
chmod +x "$tmp/bin/bun"

# One run. $1 = step to fail (empty for none). Prints the function's output,
# then "RC:<rc>" and "STEPS:<comma-separated steps actually run>".
run() {
    (
        export BUN_LOG="$tmp/log" BUN_FAIL="$1"
        : > "$BUN_LOG"
        PATH="$tmp/bin:$PATH"
        # shellcheck disable=SC1090
        . "$fn"
        local rc=0
        install_ts_wrapper "$tmp/ts" 2>&1 || rc=$?
        echo "RC:$rc"
        echo "STEPS:$(tr '\n' ',' < "$BUN_LOG")"
    )
}

local out
# The steps ACTUALLY run, as a bare comma list. Must be read off the STEPS line
# and not matched against the whole output: the error messages themselves
# contain the words "build" and "typecheck", so a `$out != *build*` test is
# always false and silently asserts nothing (it cost a red run here first).
steps_of() { printf '%s\n' "$1" | sed -n 's/^STEPS://p' | tr -d '\r'; }

# 1. Everything succeeds: all three steps run, in order, rc 0.
out="$(run '')"
[[ "$out" == *"RC:0"* ]] && [ "$(steps_of "$out")" = "install,typecheck,build," ] \
    && ok "all three steps succeed → rc 0, run in order (install, typecheck, build)" \
    || bad "happy path: rc/steps = $(steps_of "$out") / $out"

# 2. The dependency step is FATAL — this is the whole issue.
out="$(run install)"
[[ "$out" == *"RC:1"* ]] && ok "bun install fails → install stops (rc 1), was only a warning before" \
    || bad "lockfile failure not fatal: $out"
[[ "$out" == *"bun install --frozen-lockfile failed"* && "$out" == *"would not be reproducible"* ]] \
    && ok "names the failure and why it matters" || bad "no explanation: $out"
[[ "$out" == *"DISTINCTIVE-install"* ]] \
    && ok "shows bun's OWN output, not 'run it yourself to see why'" || bad "bun's output discarded: $out"
[ "$(steps_of "$out")" = "install," ] \
    && ok "stops before typecheck and build — no binary is produced from a bad tree" \
    || bad "continued past a failed dependency step, steps run: $(steps_of "$out")"

# 3. Typecheck is on the install path at all (it wasn't), and is fatal.
out="$(run typecheck)"
[[ "$out" == *"RC:1"* && "$out" == *"typecheck (tsc --noEmit) failed"* ]] \
    && ok "typecheck fails → install stops; tsc is the only step that reads node_modules" \
    || bad "typecheck not fatal or not run: $out"
[[ "$out" == *"DISTINCTIVE-typecheck"* ]] && ok "shows tsc's output" || bad "tsc output discarded: $out"
[ "$(steps_of "$out")" = "install,typecheck," ] \
    && ok "typecheck runs BEFORE the build, so a type error doesn't cost the ~90MB compile" \
    || bad "build ran despite a failed typecheck, steps run: $(steps_of "$out")"

# 4. A build failure still fails, and now shows its output too.
out="$(run build)"
[[ "$out" == *"RC:1"* && "$out" == *"dridock TS build failed"* && "$out" == *"DISTINCTIVE-build"* ]] \
    && ok "build fails → install stops, with the build's own output" || bad "build failure: $out"

# 5. The old decorative warning is gone from install.sh. A regression here
#    means someone restored the non-fatal path.
grep -q 'building with the node_modules already present' "$INSTALL" \
    && bad "install.sh still carries the old non-fatal warning: the dependency step can't fail again" \
    || ok "the old 'building with the node_modules already present' warning is gone"
grep -q 'bun run typecheck' "$INSTALL" \
    && ok "install.sh runs the typecheck" || bad "typecheck is not on the install path"

# 6. #145: the ~2 s compile runs BEFORE the multi-minute image build, so a
#    dependency or type failure doesn't first cost a full build. The binary is
#    still INSTALLED after the build, so a failed build leaves the old binary
#    beside the old images. Read off the top-level call lines in install.sh.
lineof() { grep -nE "^$1" "$INSTALL" | head -1 | cut -d: -f1; }
local l_ts l_guard l_build l_inst
l_ts="$(lineof 'install_ts_wrapper "\$SCRIPT_DIR/dridock-ts"')"
l_guard="$(lineof 'if ! install_clear_unreadable "\$SCRIPT_DIR"')"
l_build="$(lineof 'install_build_variants "\$CB_INFRA_CTX"')"
l_inst="$(lineof '\s*install -m 755 "\$TS_BIN"')"
if [ -z "$l_ts" ] || [ -z "$l_guard" ] || [ -z "$l_build" ] || [ -z "$l_inst" ]; then
    bad "couldn't find a top-level call in install.sh (ts=$l_ts guard=$l_guard build=$l_build install=$l_inst): the order checks would test nothing"
else
    [ "$l_ts" -lt "$l_build" ] \
        && ok "the compile (line $l_ts) runs before the image build (line $l_build) (#145)" \
        || bad "the compile (line $l_ts) runs after the image build (line $l_build): a lockfile drift costs a full build first"
    [ "$l_ts" -lt "$l_guard" ] \
        && ok "the compile runs before the unreadable-file guard (line $l_guard), so a stray it leaves is swept" \
        || bad "the compile (line $l_ts) runs after install_clear_unreadable (line $l_guard)"
    [ "$l_inst" -gt "$l_build" ] \
        && ok "the binary is installed after the image build (line $l_inst), so a failed build changes nothing installed" \
        || bad "the binary is installed (line $l_inst) before the image build (line $l_build)"
fi

rm -rf "$tmp"
echo "  install dep step: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_install_dep_step)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_install_dep_step
fi

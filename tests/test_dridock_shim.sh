#!/usr/bin/env bash
# ok() always returns 0, so `[ … ] && ok … || bad …` can't take both arms.
# shellcheck disable=SC2015
# #115: the in-container `dridock` shim (repo root `dridock`, baked to
# /usr/local/bin/dridock) answers the version verbs from the baked binary
# instead of refusing them as host-only.
#
# WHY: the team-watch hooks decide whether the detached fetcher is stale by
# asking `dridock --version | awk 'NR==1{print $NF}'` (#71). The shim listed
# version|-v|--version among the host-only verbs (rc 2, message on stderr), so
# in a container that pipeline always came back empty and the staleness check
# never ran there.
#
# Runs a copy of the real shim with the binary path pointed at a stub, so it
# needs no image and no docker. The structural case checks the shipped file.

_DS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_dridock_shim() {
local REPO="$_DS_DIR/.."
local SHIM="$REPO/dridock"
local BIN=/usr/local/lib/dridock/dridock
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- in-container dridock shim: version verbs reach the binary (#115) ---"

local tmp; tmp="$(mktemp -d)"
if [ "$(grep -c "$BIN" "$SHIM")" -lt 2 ]; then
    bad "the shim no longer names $BIN for both team and version; the stub swap below would test nothing"
    rm -rf "$tmp"; echo "  dridock shim: $PASS passed, $FAIL failed"; return 1
fi
# Stub binary: prints what it was asked, the way the real one prints its version.
cat > "$tmp/bin" <<'STUB'
#!/usr/bin/env bash
echo "stub-argv: $*" >&2
case "$1" in version|-v|--version) echo "dridock 9.8.7" ;; team) echo "team ok" ;; esac
STUB
chmod 755 "$tmp/bin"
python3 - "$SHIM" "$tmp/shim" "$BIN" "$tmp/bin" <<'PY'
import sys; src, dst, old, new = sys.argv[1:]
open(dst, "w").write(open(src).read().replace(old, new))
PY

local a out rc
for a in --version -v version; do
    out="$(bash "$tmp/shim" "$a" 2>"$tmp/err")"; rc=$?
    if [ "$rc" -eq 0 ] && [ "$out" = "dridock 9.8.7" ] && grep -qx "stub-argv: $a" "$tmp/err"; then
        ok "dridock $a → the baked binary, rc 0, its version on stdout"
    else
        bad "dridock $a gave rc $rc, stdout '$out', stderr: $(cat "$tmp/err")"
    fi
done

# Trailing args reach the binary rather than being dropped by the shim.
out="$(bash "$tmp/shim" --version --json 2>"$tmp/err")"; rc=$?
if [ "$rc" -eq 0 ] && grep -qx "stub-argv: --version --json" "$tmp/err"; then
    ok "dridock --version --json → the binary sees both args"
else
    bad "trailing args not forwarded: rc $rc, stderr: $(cat "$tmp/err")"
fi

# The exact pipeline the hooks run.
out="$(bash "$tmp/shim" --version 2>/dev/null | awk 'NR==1{print $NF}')"
[ "$out" = "9.8.7" ] && ok "the hooks' \`dridock --version | awk\` pipeline yields the version" \
    || bad "the hooks' pipeline yields '$out'"

# A missing binary is loud, not an empty string the hooks read as "unknown".
python3 - "$SHIM" "$tmp/shim-nobin" "$BIN" "$tmp/does-not-exist" <<'PY'
import sys; src, dst, old, new = sys.argv[1:]
open(dst, "w").write(open(src).read().replace(old, new))
PY
out="$(bash "$tmp/shim-nobin" --version 2>&1)"; rc=$?
case "$out" in
    *"missing — rebuild image"*) [ "$rc" -ne 0 ] && ok "binary missing: says so, rc $rc" || bad "binary missing but rc 0" ;;
    *) bad "binary missing not reported; got rc $rc: $out" ;;
esac

# Neighbours unchanged: team still routes, host-only verbs still refuse with rc 2.
out="$(bash "$tmp/shim" team whoami 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "team ok" ] && ok "team still routes to the binary" || bad "team routing broke: rc $rc '$out'"
for a in start checkversion doctor; do
    out="$(bash "$tmp/shim" "$a" 2>&1)"; rc=$?
    [ "$rc" -eq 2 ] && [[ "$out" == *"HOST command"* ]] && ok "dridock $a is still host-only (rc 2)" \
        || bad "dridock $a: rc $rc: $out"
done

# Help no longer claims -v/--version pass through to the Claude CLI.
out="$(bash "$tmp/shim" help)"
if [[ "$out" == *"dridock version | -v | --version"* ]] && [[ "$out" != *"passthrough to the Claude CLI"* ]]; then
    ok "help lists the version verbs as container-side, with no Claude-CLI passthrough claim"
else
    bad "help text still wrong about the version verbs"
fi

rm -rf "$tmp"
echo "  dridock shim: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_dridock_shim)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_dridock_shim
fi

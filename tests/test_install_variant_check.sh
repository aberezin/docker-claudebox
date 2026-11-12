#!/usr/bin/env bash
# #109 — install.sh builds ONE image variant per run. When the OTHER variant tag
# is present and stale, it must say so (stderr); when it is absent or current
# it must stay silent. Runs the real function, extracted from install.sh
# between its markers, against a stub `docker` whose labels the test sets.
# No docker required.

_IV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_install_variant_check() {
local INSTALL="$_IV_DIR/../install.sh"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
echo "--- install.sh: reports the variant it didn't build (#109) ---"

local tmp; tmp="$(mktemp -d)"
local fn="$tmp/fn.sh"
sed -n '/^# >>> install_report_other_variant/,/^# <<< install_report_other_variant/p' "$INSTALL" > "$fn"
if ! grep -q '^install_report_other_variant()' "$fn"; then
    bad "function block not found between the markers in install.sh"
    rm -rf "$tmp"; echo "  install variant check: $PASS passed, $FAIL failed"; return 1
fi

# Stub docker: `image inspect` prints $IV_LABELS (as the --format would) or,
# when IV_ABSENT=1, fails like a missing image.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
[ "${IV_ABSENT:-}" = 1 ] && { echo "Error: No such image" >&2; exit 1; }
printf '%s\n' "$IV_LABELS"
STUB
chmod +x "$tmp/bin/docker"

# _iv <labels|ABSENT> → stderr of the function, built=minimal, other=latest
_iv() {
    local absent=""; [ "$1" = ABSENT ] && absent=1
    ( PATH="$tmp/bin:$PATH" IV_ABSENT="$absent" IV_LABELS="$1" bash -c \
        ". '$fn'; install_report_other_variant ctx dridock:latest-minimal dridock:latest 5.14.0 2.1.319" 2>&1 )
}
# _ivm: the reverse direction — built=full, other=minimal (the ticket's host)
_ivm() {
    ( PATH="$tmp/bin:$PATH" IV_LABELS="$1" bash -c \
        ". '$fn'; install_report_other_variant ctx dridock:latest dridock:latest-minimal 5.14.0 2.1.319" 2>&1 )
}

local out
out="$(_ivm '4.3.4|<no value>')"
case "$out" in
    *"dridock:latest-minimal in the same store is stale"*"harness 4.3.4, not 5.14.0"*"no claude-version label (built before #78)"*"make build-all"*)
        ok "the ticket's host: stale minimal with no claude label is named, with both reasons" ;;
    *) bad "stale minimal not reported as expected; got: $out" ;;
esac
case "$out" in *"when DRIDOCK_MINIMAL is set"*) ok "says when dridock would run it" ;; *) bad "missing which setting runs it; got: $out" ;; esac

out="$(_iv '5.14.0|2.1.300')"
case "$out" in *"claude 2.1.300, not 2.1.319"*) ok "a claude-only lag is reported" ;; *) bad "claude lag missed; got: $out" ;; esac

out="$(_iv '5.14.0|2.1.319')"
if [ -z "$out" ]; then ok "silent when the other variant is current"; else bad "spoke about a current variant: $out"; fi

out="$(_iv ABSENT)"
if [ -z "$out" ]; then ok "silent when the other variant was never built"; else bad "spoke about an absent variant: $out"; fi

# Never fails the install, even when it reports.
if ( PATH="$tmp/bin:$PATH" IV_LABELS='1.0.0|<no value>' bash -c ". '$fn'; set -e; install_report_other_variant c a b 5.14.0 2.1.319; true" ) 2>/dev/null; then
    ok "returns success under set -e even when it reports"
else
    bad "a report made the install fail"
fi

rm -rf "$tmp"
echo "  install variant check: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_install_variant_check)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_install_variant_check
fi

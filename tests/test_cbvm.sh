#!/usr/bin/env bash
# Standalone unit tests for the Phase-2 VM-lifecycle *pure* helpers in wrapper.sh.
# No colima/docker needed — the colima-calling glue is exercised in integration.
#
# Run:  bash tests/test_cbvm.sh
#
# Standalone runner: if sourced (e.g. by test.sh's tests/test_*.sh glob), do
# nothing — don't leak `set -u`/traps or run assertions into the caller's shell.
[ "${BASH_SOURCE[0]}" != "${0}" ] && return 0 2>/dev/null

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/../wrapper.sh"

export CLAUDEBOX_SOURCE_ONLY=1
# shellcheck disable=SC1090
source "$WRAPPER"
unset CLAUDEBOX_SOURCE_ONLY

PASS=0
FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
rc()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected rc $3, got $2)"; fi; }

echo "--- cb_num (strip unit suffix) ---"
eq "8GiB"   "$(cb_num 8GiB)"    "8"
eq "60GiB"  "$(cb_num 60GiB)"   "60"
eq "4"      "$(cb_num 4)"       "4"
eq "2.5GiB" "$(cb_num 2.5GiB)"  "2.5"
eq "empty"  "$(cb_num '')"      "0"

echo "--- cb_guard_profile ---"
cb_guard_profile "cb-7f3ac9e2" 2>/dev/null; rc "cb-* allowed" "$?" "0"
cb_guard_profile "default"     2>/dev/null; rc "default refused" "$?" "1"
cb_guard_profile ""            2>/dev/null; rc "empty refused" "$?" "1"
cb_guard_profile "randomvm"    2>/dev/null; rc "non-cb refused" "$?" "1"

echo "--- cb_vm_limit_decision COUNT WARN HARD ---"
eq "0/3/5 ok"   "$(cb_vm_limit_decision 0 3 5)" "ok"
eq "2/3/5 ok"   "$(cb_vm_limit_decision 2 3 5)" "ok"
eq "3/3/5 warn" "$(cb_vm_limit_decision 3 3 5)" "warn"
eq "4/3/5 warn" "$(cb_vm_limit_decision 4 3 5)" "warn"
eq "5/3/5 deny" "$(cb_vm_limit_decision 5 3 5)" "deny"
eq "6/3/5 deny" "$(cb_vm_limit_decision 6 3 5)" "deny"
eq "bad input -> ok" "$(cb_vm_limit_decision x 3 5)" "ok"

echo "--- cb_parse_vm_lines (colima list --json) ---"
FIX='{"name":"default","status":"Running","arch":"aarch64","cpus":4,"address":"192.168.64.3"}
{"name":"cb-7f3ac9e2","status":"Running","arch":"aarch64","address":"192.168.64.5"}
{"name":"cb-1b2c3d4e","status":"Stopped","cpus":4}'
parsed="$(printf '%s\n' "$FIX" | cb_parse_vm_lines)"
eq "3 rows parsed" "$(printf '%s\n' "$parsed" | grep -c .)" "3"
eq "status field-order independent" \
   "$(printf '%s\n' '{"status":"Running","name":"cb-zz"}' | cb_parse_vm_lines)" \
   "$(printf 'cb-zz\tRunning')"

echo "--- cb_running_cb_profiles (filter) ---"
running="$(printf '%s\n' "$FIX" | cb_parse_vm_lines | cb_running_cb_profiles)"
eq "only running cb-* listed" "$running" "cb-7f3ac9e2"
eq "running count = 1" "$(printf '%s\n' "$running" | grep -c .)" "1"

echo "--- cb_status_of ---"
eq "running profile"  "$(printf '%s\n' "$FIX" | cb_parse_vm_lines | cb_status_of cb-7f3ac9e2)" "Running"
eq "stopped profile"  "$(printf '%s\n' "$FIX" | cb_parse_vm_lines | cb_status_of cb-1b2c3d4e)" "Stopped"
eq "absent profile"   "$(printf '%s\n' "$FIX" | cb_parse_vm_lines | cb_status_of cb-nope)"     "absent"

echo "--- cb_project_id_ro (no creation) ---"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
eq "empty when no config" "$(cb_project_id_ro "$TMP")" ""
[ ! -d "$TMP/.claudebox" ] && ok "id_ro did not create .claudebox" || bad "id_ro created .claudebox"
mkdir -p "$TMP/.claudebox"
printf 'id: abc1234f\n' > "$TMP/.claudebox/config.yml"
eq "reads existing id" "$(cb_project_id_ro "$TMP")" "abc1234f"

echo "--- cb_lima_home (colima delete leaks the datadisk; cb_vm_destroy reaps it) ---"
LH="$TMP/colima/_lima"; mkdir -p "$LH"
eq "COLIMA_HOME wins when set+exists" "$(COLIMA_HOME="$TMP/colima" XDG_CONFIG_HOME=/nope HOME=/nope cb_lima_home)" "$LH"
eq "falls back to XDG_CONFIG_HOME"    "$(COLIMA_HOME= XDG_CONFIG_HOME="$TMP" HOME=/nope cb_lima_home 2>/dev/null)" "$TMP/colima/_lima"
if ( COLIMA_HOME= XDG_CONFIG_HOME="$TMP/none" HOME="$TMP/none" cb_lima_home >/dev/null 2>&1 ); then
    bad "cb_lima_home returned 0 with no existing home"
else ok "cb_lima_home fails when no home exists"; fi

echo "--- cb_h (bytes -> human; used by 'vm usage'/'vm gc') ---"
eq "0 bytes"      "$(cb_h 0)"          "0B"
eq "512 bytes"    "$(cb_h 512)"        "512B"
eq "1 KiB"        "$(cb_h 1024)"       "1K"
eq "1.5 KiB"      "$(cb_h 1536)"       "1.5K"
eq "1 GiB"        "$(cb_h 1073741824)" "1G"
eq "empty -> 0B"  "$(cb_h)"            "0B"

echo "--- cb_cdp_profile (tunable debug-Chrome profile dir) ---"
eq "CLAUDEBOX_CDP_PROFILE override" "$(CLAUDEBOX_CDP_PROFILE=/tmp/my-cdp cb_cdp_profile)" "/tmp/my-cdp"
case "$(CLAUDEBOX_CDP_PROFILE= cb_cdp_profile)" in
    */claudebox/cdp/chrome-debug-profile) ok "default is clearly-named under cdp home" ;;
    *) bad "default profile path unexpected: $(CLAUDEBOX_CDP_PROFILE= cb_cdp_profile)" ;;
esac

echo "--- versioning (host wrapper must match the VERSION file) ---"
VFILE="$(cat "$SCRIPT_DIR/../VERSION" 2>/dev/null | tr -d '[:space:]')"
eq "wrapper CLAUDEBOX_VERSION == VERSION file" "$CLAUDEBOX_VERSION" "$VFILE"
echo "--- cb_semver_cmp ---"
eq "equal"          "$(cb_semver_cmp 0.1.0 0.1.0)" "eq"
eq "patch greater"  "$(cb_semver_cmp 0.1.2 0.1.0)" "gt"
eq "minor less"     "$(cb_semver_cmp 0.1.0 0.2.0)" "lt"
eq "major greater"  "$(cb_semver_cmp 1.0.0 0.9.9)" "gt"
eq "missing fields" "$(cb_semver_cmp 1 1.0.0)"     "eq"
eq "suffix ignored" "$(cb_semver_cmp 0.1.0-rc1 0.1.0)" "eq"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

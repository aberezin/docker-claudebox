#!/usr/bin/env bash
# Standalone unit tests for the Phase-5 networking *pure* helpers in wrapper.sh.
# No colima/docker needed. Run:  bash tests/test_cbnet.sh
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

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# colima list --json fixture: default has an address, cb-x has one, cb-y has none
FIX='{"name":"default","status":"Running","address":"192.168.64.3"}
{"name":"cb-abc12345","status":"Running","cpus":4,"address":"192.168.64.7"}
{"name":"cb-noaddr01","status":"Running","cpus":4}'

echo "--- cb_parse_vm_addr / cb_addr_of ---"
eq "addr present"  "$(printf '%s\n' "$FIX" | cb_parse_vm_addr | cb_addr_of cb-abc12345)" "192.168.64.7"
eq "default addr"  "$(printf '%s\n' "$FIX" | cb_parse_vm_addr | cb_addr_of default)"     "192.168.64.3"
eq "addr absent"   "$(printf '%s\n' "$FIX" | cb_parse_vm_addr | cb_addr_of cb-noaddr01)" ""
eq "unknown vm"    "$(printf '%s\n' "$FIX" | cb_parse_vm_addr | cb_addr_of cb-nope)"     ""
eq "field-order independent" \
   "$(printf '%s\n' '{"address":"10.0.0.9","name":"cb-zz"}' | cb_parse_vm_addr | cb_addr_of cb-zz)" \
   "10.0.0.9"

echo "--- cb_project_hostname ---"
mkdir -p "$TMP/proj/.claudebox"
cat > "$TMP/proj/.claudebox/config.yml" <<'EOF'
id: abc12345
network:
  hostname: cb-projectA
EOF
eq "hostname read" "$(cb_project_hostname "$TMP/proj")" "cb-projectA"
# blank hostname (comment-only) reads empty
cat > "$TMP/proj/.claudebox/config.yml" <<'EOF'
id: abc12345
network:
  hostname:               # optional
EOF
eq "blank hostname empty" "$(cb_project_hostname "$TMP/proj")" ""

echo "--- cb_hosts_ip / cb_hosts_status ---"
HOSTS="$TMP/hosts"
cat > "$HOSTS" <<'EOF'
127.0.0.1   localhost
# a comment cb-commented 1.2.3.4
192.168.64.7  cb-projectA extra-alias
10.0.0.5      other-host
EOF
eq "hosts ip lookup"        "$(cb_hosts_ip "$HOSTS" cb-projectA)" "192.168.64.7"
eq "hosts ip multi-alias"   "$(cb_hosts_ip "$HOSTS" extra-alias)" "192.168.64.7"
eq "hosts ignores comments" "$(cb_hosts_ip "$HOSTS" cb-commented)" ""
eq "hosts missing host"     "$(cb_hosts_ip "$HOSTS" nope)" ""
eq "status ok"      "$(cb_hosts_status "$HOSTS" cb-projectA 192.168.64.7)" "ok"
eq "status stale"   "$(cb_hosts_status "$HOSTS" cb-projectA 192.168.64.99)" "stale"
eq "status missing" "$(cb_hosts_status "$HOSTS" cb-new 192.168.64.7)" "missing"
eq "status missing (no file)" "$(cb_hosts_status "$TMP/nofile" cb-x 1.2.3.4)" "missing"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

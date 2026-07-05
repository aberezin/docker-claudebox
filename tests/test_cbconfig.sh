#!/usr/bin/env bash
# Standalone unit tests for the Phase-1 config layer in wrapper.sh.
# Pure host-side — no docker, no colima, no auth token needed.
#
# Run:  bash tests/test_cbconfig.sh
#
# Standalone runner: if sourced (e.g. by test.sh's tests/test_*.sh glob), do
# nothing — don't leak `set -u`/traps or run assertions into the caller's shell.
[ "${BASH_SOURCE[0]}" != "${0}" ] && return 0 2>/dev/null

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/../wrapper.sh"

# load just the cb_* functions, not the wrapper body
export CLAUDEBOX_SOURCE_ONLY=1
# shellcheck disable=SC1090
source "$WRAPPER"
unset CLAUDEBOX_SOURCE_ONLY

PASS=0
FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
match() { if printf '%s' "$2" | grep -qE "$3"; then ok "$1"; else bad "$1 ('$2' !~ /$3/)"; fi; }
isfile() { if [ -f "$1" ]; then ok "$2"; else bad "$2 (missing $1)"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# isolate the machine-wide config under a temp XDG dir
export XDG_CONFIG_HOME="$TMP/xdg"

echo "--- id generation ---"
id1="$(cb_gen_id)"
id2="$(cb_gen_id)"
match "gen_id is 8 hex" "$id1" '^[0-9a-f]{8}$'
if [ "$id1" != "$id2" ]; then ok "gen_id varies"; else bad "gen_id repeated: $id1"; fi

echo "--- baked defaults (no machine config) ---"
eq "vm.default_cpu"    "$(cb_machine_get vm.default_cpu)"    "4"
eq "vm.default_memory" "$(cb_machine_get vm.default_memory)" "8GiB"
eq "vm.warn_max"       "$(cb_machine_get vm.warn_max)"       "3"
eq "vm.hard_max"       "$(cb_machine_get vm.hard_max)"       "5"
eq "data_root default" "$(cb_data_root)" "$TMP/xdg/claudebox/projects"

echo "--- machine config overrides ---"
mkdir -p "$TMP/xdg/claudebox"
cat > "$TMP/xdg/claudebox/config.yml" <<'EOF'
# machine-wide
vm:
  warn_max: 7
  hard_max: 9
  default_cpu: 2
data_root: ~/somewhere/vms
EOF
eq "warn_max override"    "$(cb_machine_get vm.warn_max)"    "7"
eq "hard_max override"    "$(cb_machine_get vm.hard_max)"    "9"
eq "default_cpu override" "$(cb_machine_get vm.default_cpu)" "2"
eq "default_memory still baked" "$(cb_machine_get vm.default_memory)" "8GiB"
eq "data_root ~ expansion" "$(cb_data_root)" "$HOME/somewhere/vms"

echo "--- project init (git repo) ---"
PROJ="$TMP/proj"
mkdir -p "$PROJ"
git -C "$PROJ" init -q
pid="$(cb_init_project_config "$PROJ")"
match "project id 8 hex" "$pid" '^[0-9a-f]{8}$'
isfile "$PROJ/.claudebox/config.yml" "config.yml created"
isfile "$PROJ/.claudebox/config.sample.yml" "config.sample.yml created"
match "gitignore wired" "$(cat "$PROJ/.gitignore" 2>/dev/null)" '^/\.claudebox/config\.yml$'

echo "--- read-back / idempotency ---"
eq "project_id reads existing" "$(cb_project_id "$PROJ")" "$pid"
pid2="$(cb_init_project_config "$PROJ")"
eq "re-init keeps id" "$pid2" "$pid"
# duplicate gitignore lines must not accumulate
cb_init_project_config "$PROJ" >/dev/null
count="$(grep -cxF '/.claudebox/config.yml' "$PROJ/.gitignore")"
eq "gitignore not duplicated" "$count" "1"

echo "--- vm sizing (cpu seeded from machine default_cpu=2) ---"
eq "vm cpu from config"  "$(cb_vm_get "$PROJ" cpu)"      "2"
eq "vm memory default"   "$(cb_vm_get "$PROJ" memory)"   "8GiB"
eq "vm disk default"     "$(cb_vm_get "$PROJ" disk)"     "60GiB"
eq "vm autostop default" "$(cb_vm_get "$PROJ" autostop)" "false"

echo "--- comment-only value reads empty ---"
eq "network.hostname empty" "$(_cb_yaml_get "$PROJ/.claudebox/config.yml" network.hostname)" ""

echo "--- rehome safety (move dir, id stable) ---"
mv "$PROJ" "$TMP/proj-moved"
eq "id stable after rehome" "$(cb_project_id "$TMP/proj-moved")" "$pid"

echo "--- init in a non-git dir does not create .gitignore ---"
NOGIT="$TMP/plain"
mkdir -p "$NOGIT"
cb_init_project_config "$NOGIT" >/dev/null
if [ ! -f "$NOGIT/.gitignore" ]; then ok "no .gitignore in non-git dir"; else bad ".gitignore created in non-git dir"; fi

echo "--- derived names ---"
eq "profile name" "$(cb_project_profile "$pid")"  "cb-$pid"
eq "context name" "$(cb_project_context "$pid")"  "colima-cb-$pid"
eq "data dir"     "$(cb_project_data_dir "$pid")" "$(cb_data_root)/$pid/claude"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

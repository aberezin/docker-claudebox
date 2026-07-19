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
eq "data_root default" "$(cb_data_root)" "$TMP/xdg/dridock/projects"

echo "--- machine config overrides ---"
mkdir -p "$TMP/xdg/dridock"
cat > "$TMP/xdg/dridock/config.yml" <<'EOF'
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
isfile "$PROJ/.dridock/config.yml" "config.yml created"
isfile "$PROJ/.dridock/config.sample.yml" "config.sample.yml created"
match "gitignore wired" "$(cat "$PROJ/.gitignore" 2>/dev/null)" '^/\.dridock/config\.yml$'

echo "--- read-back / idempotency ---"
eq "project_id reads existing" "$(cb_project_id "$PROJ")" "$pid"
pid2="$(cb_init_project_config "$PROJ")"
eq "re-init keeps id" "$pid2" "$pid"
# duplicate gitignore lines must not accumulate
cb_init_project_config "$PROJ" >/dev/null
count="$(grep -cxF '/.dridock/config.yml' "$PROJ/.gitignore")"
eq "gitignore not duplicated" "$count" "1"

echo "--- vm sizing (cpu seeded from machine default_cpu=2) ---"
eq "vm cpu from config"  "$(cb_vm_get "$PROJ" cpu)"      "2"
eq "vm memory default"   "$(cb_vm_get "$PROJ" memory)"   "8GiB"
eq "vm disk default"     "$(cb_vm_get "$PROJ" disk)"     "60GiB"
eq "vm autostop default" "$(cb_vm_get "$PROJ" autostop)" "false"

echo "--- comment-only value reads empty ---"
eq "network.hostname empty" "$(_cb_yaml_get "$PROJ/.dridock/config.yml" network.hostname)" ""

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

# ── 3.0 migration helpers (#11 phase 4b) ────────────────────────────────────
# cb_migrate_workspace: workspace state (.claudebox/ → .dridock/ + gitignore rewrite).
# cb_migrate_data_dir:  per-project session state (~/.config/claudebox/projects/<id> → dridock).
# cb_migrate_machine_config: machine config file (~/.config/claudebox/config.yml → dridock).
# All three must be idempotent and each must be a no-op when the legacy dir/file isn't there.
echo "--- migration: cb_migrate_workspace ---"
MIG="$TMP/mig-ws"
mkdir -p "$MIG/.claudebox"
printf 'id: mig11111\n' > "$MIG/.claudebox/config.yml"
printf 'GH_TOKEN=x\n'   > "$MIG/.claudebox/secrets.env"; chmod 600 "$MIG/.claudebox/secrets.env"
printf '# brief\n'      > "$MIG/.claudebox/BRIEF.md"
printf '# sample\n'     > "$MIG/.claudebox/config.sample.yml"
printf '/.claudebox/config.yml\n/.claudebox/secrets.env\n/build/\n' > "$MIG/.gitignore"
cb_migrate_workspace "$MIG" >/dev/null
isfile "$MIG/.dridock/config.yml"        "workspace: config.yml moved"
isfile "$MIG/.dridock/secrets.env"       "workspace: secrets.env moved"
isfile "$MIG/.dridock/BRIEF.md"          "workspace: BRIEF.md moved"
isfile "$MIG/.dridock/config.sample.yml" "workspace: config.sample.yml moved"
if [ ! -d "$MIG/.claudebox" ]; then ok "workspace: legacy dir removed"; else bad "workspace: legacy dir remains"; fi
eq "workspace: secrets mode preserved" "$(stat -c '%a' "$MIG/.dridock/secrets.env")" "600"
match "workspace: gitignore rewritten (config)"  "$(cat "$MIG/.gitignore")" '^/\.dridock/config\.yml$'
match "workspace: gitignore rewritten (secrets)" "$(cat "$MIG/.gitignore")" '^/\.dridock/secrets\.env$'
match "workspace: gitignore preserves other lines" "$(cat "$MIG/.gitignore")" '^/build/$'
cb_migrate_workspace "$MIG" >/dev/null
ok "workspace: re-run is idempotent no-op"

echo "--- migration: cb_migrate_data_dir ---"
MIG_ID=migdata1
export XDG_CONFIG_HOME="$TMP/xdg-mig"
mkdir -p "$XDG_CONFIG_HOME/claudebox/projects/$MIG_ID/claude"
printf 'x\n' > "$XDG_CONFIG_HOME/claudebox/projects/$MIG_ID/claude/.claude.json"
cb_migrate_data_dir "$MIG_ID" >/dev/null
isfile "$XDG_CONFIG_HOME/dridock/projects/$MIG_ID/claude/.claude.json" "data dir: contents moved"
if [ ! -d "$XDG_CONFIG_HOME/claudebox/projects/$MIG_ID" ]; then ok "data dir: legacy removed"; else bad "data dir: legacy remains"; fi
cb_migrate_data_dir "$MIG_ID" >/dev/null && ok "data dir: re-run is idempotent no-op" || bad "data dir: re-run failed"
cb_migrate_data_dir "does-not-exist" >/dev/null && ok "data dir: missing id is no-op" || bad "data dir: missing id errored"

echo "--- migration: cb_migrate_machine_config ---"
# machine config still at legacy path in the test XDG (data-dir test above only moved projects/)
mkdir -p "$XDG_CONFIG_HOME/claudebox"
printf 'vm:\n  default_cpu: 3\n' > "$XDG_CONFIG_HOME/claudebox/config.yml"
cb_migrate_machine_config >/dev/null
isfile "$XDG_CONFIG_HOME/dridock/config.yml" "machine config: moved"
if [ ! -f "$XDG_CONFIG_HOME/claudebox/config.yml" ]; then ok "machine config: legacy removed"; else bad "machine config: legacy remains"; fi
cb_migrate_machine_config >/dev/null && ok "machine config: re-run is idempotent no-op" || bad "machine config: re-run failed"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

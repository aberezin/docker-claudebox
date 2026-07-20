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
[ ! -d "$TMP/.dridock" ] && ok "id_ro did not create .dridock" || bad "id_ro created .dridock"
mkdir -p "$TMP/.dridock"
printf 'id: abc1234f\n' > "$TMP/.dridock/config.yml"
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
eq "DRIDOCK_CDP_PROFILE override" "$(DRIDOCK_CDP_PROFILE=/tmp/my-cdp cb_cdp_profile)" "/tmp/my-cdp"
case "$(DRIDOCK_CDP_PROFILE= cb_cdp_profile)" in
    */claudebox/cdp/chrome-debug-profile) ok "default is clearly-named under cdp home" ;;
    *) bad "default profile path unexpected: $(CLAUDEBOX_CDP_PROFILE= cb_cdp_profile)" ;;
esac

echo "--- CDP bridge sidecar contract (wrapper writes -cdp, entrypoint re-reads it) ---"
# Regression for the 2.5.2 bug: CLAUDEBOX_HOST_CDP_URL was injected only via
# `docker run -e`, so an already-running container never saw `browser-bridge up`.
# The fix persists it to a durable `.<container>-cdp` sidecar the entrypoint re-reads
# each start. This is a cross-file naming contract (like -auth/-secrets) — assert both
# halves agree so they can't silently drift apart.
ENTRYP="$SCRIPT_DIR/../entrypoint.sh"
if grep -q 'container_name}${_crole}-cdp' "$WRAPPER"; then ok "wrapper writes -cdp sidecar (all roles)"; else bad "wrapper no longer writes the -cdp sidecar"; fi
if grep -q '${CLAUDE_CONTAINER_NAME}-cdp' "$ENTRYP"; then ok "entrypoint re-reads the -cdp sidecar"; else bad "entrypoint no longer reads the -cdp sidecar"; fi
# empty sidecar must UNSET (bridge-down must clear a stale URL, not leave it exported)
if grep -A12 '${CLAUDE_CONTAINER_NAME}-cdp' "$ENTRYP" | grep -q 'unset \$name'; then ok "entrypoint unsets CDP url when sidecar empty"; else bad "entrypoint does not unset on empty -cdp (stale bridge url would linger)"; fi
# wrapper writes the sidecar unconditionally (mirror), so bridge-down -> empty on next run
if grep -qE "printf '(DRIDOCK|CLAUDEBOX)_HOST_CDP_URL=%s\\\\n' \"\\\$_cdp_url\"" "$WRAPPER"; then ok "wrapper mirrors marker->sidecar unconditionally (self-heals to empty)"; else bad "wrapper -cdp write is not the unconditional mirror"; fi

echo "--- cb_vm_gc orphan detection must be profile-based, NOT the dangerous IN-USE-BY heuristic ---"
# Regression for a data-loss bug: the orphan test used `limactl disk ls | awk NF<5`, but
# IN-USE-BY is blank for every STOPPED VM, so gc deleted valid stopped VMs' disks (incl. the
# cb-infra image store). The fix cross-references disk names against known colima profiles.
if grep -q 'NR>1 && NF<5' "$WRAPPER"; then bad "cb_vm_gc still keys orphan detection on NF<5 (deletes stopped VMs' disks!)"; else ok "cb_vm_gc no longer uses the NF<5 orphan heuristic"; fi
if grep -q 'no owning colima profile' "$WRAPPER"; then ok "cb_vm_gc orphan detection is profile-based"; else bad "cb_vm_gc orphan detection is not profile-based"; fi

echo "--- cb_vm_gc prunes build cache (the real accumulator), not just dangling images ---"
# Regression for the disk-management consult: `vm gc` used to run only `image prune`
# (dangling images) + fstrim, never `builder prune` (build cache), which is what actually
# fills an image-iterating project's VM. Assert both prunes are present.
if grep -q 'builder prune -f' "$WRAPPER"; then ok "cb_vm_gc prunes BuildKit build cache"; else bad "cb_vm_gc no longer prunes build cache"; fi
if grep -q 'image prune -f' "$WRAPPER"; then ok "cb_vm_gc still prunes dangling images"; else bad "cb_vm_gc no longer prunes dangling images"; fi

echo "--- consult substrate (cb_consult_* thread helpers + wrapper<->cb-consult contract) ---"
CT="$(mktemp -d)/t1"
cb_consult_meta_set "$CT" status awaiting-framework
cb_consult_meta_set "$CT" title "n-tier cors"
eq "meta status set"   "$(cb_consult_status "$CT")" "awaiting-framework"
printf 'the problem\n' | cb_consult_post "$CT" claudebot
printf 'the reply\n'   | cb_consult_post "$CT" framework
[ -f "$CT/001-claudebot.md" ] && ok "first turn numbered 001-claudebot" || bad "001-claudebot.md missing"
[ -f "$CT/002-framework.md" ] && ok "second turn numbered 002-framework" || bad "002-framework.md missing"
cb_consult_meta_set "$CT" status awaiting-approval
eq "status transition"  "$(cb_consult_status "$CT")" "awaiting-approval"
# watch (B): cb_consult_sig must change when status/turns change, so `watch` detects it
_sig1="$(cb_consult_sig "$(dirname "$CT")")"
printf 'another turn\n' | cb_consult_post "$CT" human
cb_consult_meta_set "$CT" status awaiting-claudebot
_sig2="$(cb_consult_sig "$(dirname "$CT")")"
if [ "$_sig1" != "$_sig2" ]; then ok "cb_consult_sig changes on status/turn change (watch fires)"; else bad "cb_consult_sig did not change (watch would miss it)"; fi
case "$_sig2" in *"|awaiting-claudebot|"*) ok "sig encodes id|status|nturns" ;; *) bad "sig format unexpected: $_sig2" ;; esac
# cross-file naming contract: the container helper cb-consult and the host wrapper must
# agree on the mount path + env var (like framework-bugs) or a thread opened in one is
# invisible to the other.
CBC="$SCRIPT_DIR/../cb-consult"
if grep -q 'framework-consult' "$WRAPPER" && grep -q 'framework-consult' "$CBC"; then ok "wrapper & cb-consult agree on /home/claude/framework-consult mount"; else bad "consult mount path drifted between wrapper and cb-consult"; fi
if grep -q 'CLAUDEBOX_CONSULT_DIR' "$WRAPPER" && grep -q 'CLAUDEBOX_CONSULT_DIR' "$CBC"; then ok "wrapper & cb-consult agree on CLAUDEBOX_CONSULT_DIR"; else bad "CLAUDEBOX_CONSULT_DIR drifted"; fi
rm -rf "$(dirname "$CT")"

echo "--- host agent (#15 Approach 2, phase 1): security posture + wiring contract ---"
HAPY="$SCRIPT_DIR/../host-agent.py"; HASH="$SCRIPT_DIR/../cb-host-shim"
[ -f "$HAPY" ] && ok "host-agent.py present" || bad "host-agent.py missing"
grep -q 'CB_HOST_AGENT_TOKEN' "$HAPY" && grep -q 'sys.exit(1)' "$HAPY" && ok "agent refuses to start without a token" || bad "agent token-gate missing"
grep -q '"192.168.64.1"' "$HAPY" && ok "agent binds the Colima gateway (not 0.0.0.0/LAN)" || bad "agent bind not gateway-scoped"
grep -q 'ALLOW = {' "$HAPY" && grep -q '"colima"' "$HAPY" && grep -q '"limactl"' "$HAPY" && ok "agent allowlists colima/limactl (binary+subcommand)" || bad "agent allowlist missing"
grep -q 'CLAUDEBOX_HOST_AGENT_URL' "$HASH" && grep -q 'CLAUDEBOX_HOST_AGENT_TOKEN' "$HASH" && ok "shim reads the injected URL+token" || bad "shim env contract missing"
# wrapper injects the durable -hostagent sidecar; entrypoint re-reads it
grep -q 'container_name}${_crole}-hostagent' "$WRAPPER" && ok "wrapper writes -hostagent sidecar" || bad "wrapper -hostagent sidecar missing"
grep -q '${CLAUDE_CONTAINER_NAME}-hostagent' "$ENTRYP" && ok "entrypoint re-reads -hostagent sidecar" || bad "entrypoint -hostagent reader missing"
if declare -f cb_host_agent_up >/dev/null && declare -f cb_host_agent_down >/dev/null; then ok "cb_host_agent_up/down defined"; else bad "host-agent wrapper functions missing"; fi
# phase 3: Makefile + tests are backend-aware (docker backend builds/tests locally, no colima)
MK="$SCRIPT_DIR/../Makefile"; CMN="$SCRIPT_DIR/common.sh"
grep -qE '(DRIDOCK|CLAUDEBOX)_BACKEND' "$MK" && grep -qE 'ifeq \(\$\((DRIDOCK|CLAUDEBOX)_BACKEND\),docker\)' "$MK" && ok "Makefile is backend-aware (colima|docker)" || bad "Makefile backend branch missing"
grep -q 'CBX_BACKEND' "$CMN" && grep -q '/.dockerenv' "$CMN" && ok "test harness auto-selects docker backend in a container" || bad "common.sh backend detection missing"

echo "--- bootstrap --adopt (existing repos, no nesting) ---"
_orig_pf="$(declare -f cb_preflight)"; cb_preflight() { return 0; }   # stub VM/tooling preflight
BT="$(mktemp -d)"
# brief framing by flavor (greenfield / adopt / workspace)
cb_write_brief "$BT/g" "x" ""        ; grep -q 'ADOPTS an existing\|MULTI-REPO' "$BT/g/.dridock/BRIEF.md" && bad "greenfield brief has a flavor note" || ok "greenfield brief: no flavor note"
cb_write_brief "$BT/a" "x" adopt     ; grep -q 'ADOPTS an existing' "$BT/a/.dridock/BRIEF.md" && ok "adopt brief carries the adopt note" || bad "adopt note missing"
cb_write_brief "$BT/w" "x" workspace ; grep -q 'MULTI-REPO workspace' "$BT/w/.dridock/BRIEF.md" && ok "workspace brief carries the multi-repo note" || bad "workspace note missing"
# cb_bootstrap on an existing repo must NOT add README/workloads (greenfield scaffolding)
mkdir -p "$BT/r"; ( cd "$BT/r" && git init -q && : > f && git add -A && git -c user.email=t@t -c user.name=t commit -qm i ) >/dev/null 2>&1
( cd "$BT/r" && cb_bootstrap "$BT/r" "x" brief "" ) >/dev/null 2>&1
{ [ ! -f "$BT/r/README.md" ] && [ ! -d "$BT/r/workloads" ]; } && ok "cb_bootstrap skips greenfield scaffolding on an existing repo" || bad "cb_bootstrap polluted an existing repo"
grep -q 'ADOPTS an existing' "$BT/r/.dridock/BRIEF.md" 2>/dev/null && ok "auto-detected adopt (existing .git)" || bad "did not auto-detect adopt"
# cb_clone_adopt refuses a non-empty dir (no clobber / nesting). Capture output (it returns
# non-zero on refusal, which under `set -o pipefail` would trip a piped grep).
mkdir "$BT/ne"; : > "$BT/ne/x"
_ca_out="$( cd "$BT/ne" && cb_clone_adopt /tmp/nope 2>&1 || true )"
case "$_ca_out" in *"not empty"*) ok "cb_clone_adopt refuses a non-empty dir" ;; *) bad "cb_clone_adopt did not refuse non-empty" ;; esac
# workspace flavor (#13): orchestration parent = git init + README, but NO workloads/
mkdir -p "$BT/ws"; ( cd "$BT/ws" && cb_bootstrap "$BT/ws" "x" full "" workspace ) >/dev/null 2>&1
{ [ -f "$BT/ws/README.md" ] && [ ! -d "$BT/ws/workloads" ] && [ -e "$BT/ws/.git" ]; } && ok "workspace: git init + README, no workloads/" || bad "workspace scaffolding wrong"
grep -q 'MULTI-REPO workspace' "$BT/ws/.dridock/BRIEF.md" 2>/dev/null && ok "workspace BRIEF is multi-repo framed" || bad "workspace BRIEF not multi-repo framed"
rm -rf "$BT"; eval "$_orig_pf"   # restore the real cb_preflight

echo "--- disk nice-to-haves (2.11.0): vm.disk default, prune-on-start, tmpfs, disk MOTD ---"
eq "vm.disk default is 100GiB" "$(cb_machine_get vm.default_disk)" "100GiB"
if grep -qE '(DRIDOCK|CLAUDEBOX)_PRUNE_ON_START' "$ENTRYP"; then ok "entrypoint honors PRUNE_ON_START"; else bad "prune-on-start missing"; fi
if grep -qE '(DRIDOCK|CLAUDEBOX)_TMPFS_TMP' "$WRAPPER" && grep -q 'tmpfs "/tmp' "$WRAPPER"; then ok "wrapper supports TMPFS_TMP (--tmpfs /tmp)"; else bad "tmpfs /tmp opt-in missing"; fi
if grep -q 'DISK_NOTE=' "$ENTRYP" && grep -q '85' "$ENTRYP"; then ok "entrypoint has the startup disk MOTD (>=85%)"; else bad "disk MOTD missing"; fi
# guidance trim: the exhaustive per-language tool lists are gone
if grep -q '^## Go Tools' "$ENTRYP"; then bad "guidance still carries the exhaustive tool inventory"; else ok "guidance tool inventory trimmed"; fi

echo "--- framework guidance goes to user memory (~/.claude/CLAUDE.md), not a once-copied workspace file ---"
# Regression for the existing-repo guidance gap (task #10): the entrypoint must write guidance
# to the user-memory file EVERY start, and must NOT copy a template into the workspace ./CLAUDE.md.
if grep -q 'CLAUDE_MD_USER="/home/claude/.claude/CLAUDE.md"' "$ENTRYP"; then ok "entrypoint targets ~/.claude/CLAUDE.md (user memory)"; else bad "entrypoint no longer writes user-memory CLAUDE.md"; fi
if grep -q '} > "\$CLAUDE_MD_USER"' "$ENTRYP"; then ok "guidance block redirects to user memory"; else bad "guidance block does not write CLAUDE_MD_USER"; fi
if grep -q 'CLAUDE_MD_TEMPLATE' "$ENTRYP"; then bad "stale CLAUDE_MD_TEMPLATE still referenced"; else ok "no stale CLAUDE_MD_TEMPLATE refs"; fi
if grep -q 'cp .*CLAUDE_MD.*WORKSPACE_DIR/CLAUDE.md' "$ENTRYP"; then bad "entrypoint still copies a template into the workspace CLAUDE.md"; else ok "entrypoint does not seed a workspace ./CLAUDE.md"; fi

echo "--- consult watch actionability: fire on new awaiting-framework, NOT on framework's own posts ---"
# Regression for the self-trigger papercut: `consult watch` used to wake on ANY thread change,
# so framework-Claude posting a draft/approval re-triggered its own watcher. The watch now
# tracks only threads ENTERING awaiting-framework (additions), so its own awaiting-approval/
# awaiting-claudebot posts are silent.
WT="$(mktemp -d)"
mkdir -p "$WT/t1"; printf 'id=t1\nproject=p\ntitle=x\nstatus=awaiting-approval\n' > "$WT/t1/meta"; echo a > "$WT/t1/001-claudebot.md"
_wact() { cb_consult_sig "$WT" | awk -F'|' '$2=="awaiting-framework"{print $1"|"$3}' | sort; }
_wbase="$(_wact)"
# framework posts a draft -> awaiting-claudebot (its own change): must NOT be a new actionable item
printf 'status=awaiting-claudebot\n' > "$WT/t1/meta"; echo b > "$WT/t1/002-framework.md"
_wnew="$(comm -13 <(printf '%s\n' "$_wbase") <(_wact))"
[ -z "$_wnew" ] && ok "framework's own post does not wake the watcher" || bad "self-trigger: '$_wnew'"
# a new claudebot consult -> awaiting-framework: MUST fire
mkdir -p "$WT/t2"; printf 'id=t2\nproject=p\ntitle=y\nstatus=awaiting-framework\n' > "$WT/t2/meta"; echo q > "$WT/t2/001-claudebot.md"
_wnew="$(comm -13 <(printf '%s\n' "$_wbase") <(_wact))"
case "$_wnew" in *t2*) ok "new awaiting-framework consult wakes the watcher" ;; *) bad "missed new consult: '$_wnew'" ;; esac
rm -rf "$WT"

echo "--- VM-IP sidecar contract (wrapper injects CLAUDEBOX_VM_IP, entrypoint re-reads) ---"
# The claudebot container can't self-discover the VM's reachable IP (it's on the 172.x
# bridge), and the IP rotates across restarts — so the wrapper mirrors the CURRENT IP to
# a durable `.<container>-vmip` sidecar every run and the entrypoint re-reads it. Assert
# both halves of this cross-file contract agree.
if grep -q 'container_name}${_crole}-vmip' "$WRAPPER"; then ok "wrapper writes -vmip sidecar (all roles)"; else bad "wrapper no longer writes the -vmip sidecar"; fi
if grep -q '${CLAUDE_CONTAINER_NAME}-vmip' "$ENTRYP"; then ok "entrypoint re-reads the -vmip sidecar"; else bad "entrypoint no longer reads the -vmip sidecar"; fi
if grep -qE '(DRIDOCK|CLAUDEBOX)_VM_IP=%s' "$WRAPPER"; then ok "wrapper mirrors current IP -> sidecar (tracks rotation)"; else bad "wrapper -vmip write is not the current-IP mirror"; fi
if grep -A12 '${CLAUDE_CONTAINER_NAME}-vmip' "$ENTRYP" | grep -q 'unset \$name'; then ok "entrypoint unsets VM IP when sidecar empty"; else bad "entrypoint does not unset on empty -vmip"; fi

echo "--- cb_project_profiles (config 'profiles:' — flow + block + none) ---"
PT="$(mktemp -d)"; mkdir -p "$PT/f/.dridock" "$PT/b/.dridock" "$PT/n/.dridock"
printf 'id: aaaa1111\nprofiles: [typescript, python]\nvm:\n  cpu: 4\n' > "$PT/f/.dridock/config.yml"
printf 'id: bbbb2222\nprofiles:\n  - typescript   # ts\n  - go\nnetwork:\n  hostname:\n' > "$PT/b/.dridock/config.yml"
printf 'id: cccc3333\nvm:\n  cpu: 4\n' > "$PT/n/.dridock/config.yml"
eq "flow style"  "$(cb_project_profiles "$PT/f")" "python typescript"
eq "block style" "$(cb_project_profiles "$PT/b")" "go typescript"
eq "none"        "$(cb_project_profiles "$PT/n")" ""
rm -rf "$PT"

echo "--- cb_in_dotclaudebox (workspace guard predicate) ---"
cb_in_dotclaudebox /Users/x/proj/.dridock     && ok "flags .dridock dir"        || bad "missed .dridock"
cb_in_dotclaudebox /Users/x/proj/.dridock/sub && ok "flags .dridock subpath"    || bad "missed .dridock/sub"
if cb_in_dotclaudebox /Users/x/proj;       then bad "false positive: project root"; else ok "project root not flagged"; fi
if cb_in_dotclaudebox /Users/x/proj/apps;  then bad "false positive: normal subdir"; else ok "normal subdir not flagged"; fi

echo "--- versioning (host wrapper must match the VERSION file) ---"
VFILE="$(cat "$SCRIPT_DIR/../VERSION" 2>/dev/null | tr -d '[:space:]')"
eq "wrapper DRIDOCK_VERSION == VERSION file" "$DRIDOCK_VERSION" "$VFILE"
echo "--- cb_semver_cmp ---"
eq "equal"          "$(cb_semver_cmp 0.1.0 0.1.0)" "eq"
eq "patch greater"  "$(cb_semver_cmp 0.1.2 0.1.0)" "gt"
eq "minor less"     "$(cb_semver_cmp 0.1.0 0.2.0)" "lt"
eq "major greater"  "$(cb_semver_cmp 1.0.0 0.9.9)" "gt"
eq "missing fields" "$(cb_semver_cmp 1 1.0.0)"     "eq"
eq "suffix ignored" "$(cb_semver_cmp 0.1.0-rc1 0.1.0)" "eq"
echo "--- cb_semver_severity (drift urgency: major=must / minor=should / patch=optional) ---"
eq "same"      "$(cb_semver_severity 2.0.0 2.0.0)" "none"
eq "patch"     "$(cb_semver_severity 2.0.1 2.0.0)" "patch"
eq "minor"     "$(cb_semver_severity 2.1.0 2.0.9)" "minor"
eq "major"     "$(cb_semver_severity 3.0.0 2.9.9)" "major"
eq "major beats minor" "$(cb_semver_severity 3.1.0 2.9.0)" "major"

echo "--- cb_purge_data (destroy --purge) guards ---"
if ( cb_purge_data "" >/dev/null 2>&1 ); then bad "purge accepted empty id"; else ok "purge refuses empty id"; fi
if ( cb_purge_data "../etc" >/dev/null 2>&1 ); then bad "purge accepted path-y id"; else ok "purge refuses path-like id"; fi
if ( DRIDOCK_DATA_DIR=/whatever cb_purge_data deadbeef 2>&1 | grep -q 'not auto-deleting' ); then ok "purge refuses when DATA_DIR override set"; else bad "purge ignored DATA_DIR override"; fi
# real purge under a temp data root
PTMP="$(mktemp -d)"; ( export XDG_CONFIG_HOME="$PTMP"
  DDIR="$(cb_data_root)/deadbeef/claude"; mkdir -p "$DDIR"; touch "$DDIR/session.jsonl"
  SIB="$(cb_data_root)/cafe0000/claude"; mkdir -p "$SIB"
  cb_purge_data deadbeef >/dev/null 2>&1
  [ ! -e "$(cb_data_root)/deadbeef" ] && echo PURGED || echo KEPT
  [ -d "$SIB" ] && echo SIBOK || echo SIBGONE ) > "$PTMP/out"
grep -q PURGED "$PTMP/out" && ok "purge removes the project's data dir" || bad "purge did not remove data dir"
grep -q SIBOK  "$PTMP/out" && ok "purge leaves other projects untouched" || bad "purge touched a sibling project"
rm -rf "$PTMP"

echo "--- lint: every cb_* function CALLED is DEFINED (catches rename/undefined regressions) ---"
_defined="$(grep -oE '^[[:space:]]*_?cb_[a-z0-9_]+\(\)' "$WRAPPER" | grep -oE '_?cb_[a-z0-9_]+' | sort -u)"
# "used" = cb_* in CALL position: strip comments, then variable refs ($cb_x) and
# assignments (cb_x=) so vars aren't mistaken for undefined functions. Command
# substitution $(cb_x ...) is preserved (that IS a call).
_used="$(sed 's/#.*//' "$WRAPPER" | sed -E 's/\$_?cb_[a-z0-9_]+//g; s/_?cb_[a-z0-9_]+=/=/g' | grep -oE '_?cb_[a-z0-9_]+' | sort -u)"
_missing=""
for _f in $_used; do printf '%s\n' "$_defined" | grep -qx "$_f" || _missing="$_missing $_f"; done
[ -z "$_missing" ] && ok "no undefined cb_* function calls" || bad "undefined cb_* funcs called:$_missing"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

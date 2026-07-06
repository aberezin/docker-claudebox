#!/usr/bin/env bash

# CLAUDEBOX_* is the canonical prefix. CLAUDE_* names remain supported for backwards compat.

# ─────────────────────────────────────────────────────────────────────────────
# Config layer — Phase 1 of docs/design/per-project-vm.md
#
# Pure host-side helpers: per-project identity (.claudebox/config.yml, kept
# rehome-safe via a marker file rather than a path hash), the committed sample,
# .gitignore wiring, and the machine-wide config (~/.config/claudebox/config.yml)
# with baked-in defaults. No docker/colima here. Source this file with
# CLAUDEBOX_SOURCE_ONLY=1 to load just these functions (tests/test_cbconfig.sh).
# ─────────────────────────────────────────────────────────────────────────────

cb_config_home() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

cb_machine_config_path() {
    local base="$(cb_config_home)/claudebox"
    if [ -f "$base/config.yaml" ] && [ ! -f "$base/config.yml" ]; then
        printf '%s' "$base/config.yaml"
    else
        printf '%s' "$base/config.yml"
    fi
}

# baked-in defaults, used when neither project nor machine config supplies a value
cb_baked_default() {
    case "$1" in
        vm.cpu|vm.default_cpu)       printf '4' ;;
        vm.memory|vm.default_memory) printf '8GiB' ;;
        vm.disk|vm.default_disk)     printf '60GiB' ;;
        vm.autostop)                 printf 'false' ;;
        vm.warn_max)                 printf '3' ;;
        vm.hard_max)                 printf '5' ;;
        data_root)                   printf '%s' "$(cb_config_home)/claudebox/projects" ;;
        *)                           printf '' ;;
    esac
}

# _cb_yaml_get FILE DOTTED_KEY — minimal reader for the 2-level YAML we generate.
# Supports top-level `key: val` and one level of nesting `parent:\n  key: val`.
_cb_yaml_get() {
    [ -f "$1" ] || return 0
    awk -v want="$2" '
        function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t\r]+$/,"",s); return s }
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        {
            tmp=$0; indent=0
            while (substr(tmp,1,1)==" ") { indent++; tmp=substr(tmp,2) }
            pos=index(tmp,":"); if (pos==0) next
            key=trim(substr(tmp,1,pos-1)); val=trim(substr(tmp,pos+1))
            if (substr(val,1,1)=="#") { val="" }
            else { c=index(val," #"); if (c>0) val=trim(substr(val,1,c-1)) }
            if (indent==0) { parent=key; if (key==want) { print val; exit } }
            else { if (parent"."key==want) { print val; exit } }
        }
    ' "$1"
}

# read a value from the machine-wide config, falling back to the baked default
cb_machine_get() {
    local key="$1" f v=""
    f="$(cb_machine_config_path)"
    [ -f "$f" ] && v="$(_cb_yaml_get "$f" "$key")"
    [ -z "$v" ] && v="$(cb_baked_default "$key")"
    printf '%s' "$v"
}

# expand a leading ~ to $HOME
cb_expand_path() {
    case "$1" in
        "~")   printf '%s' "$HOME" ;;
        "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
        *)     printf '%s' "$1" ;;
    esac
}

cb_data_root() { cb_expand_path "$(cb_machine_get data_root)"; }

# 8 lowercase-hex chars — a valid colima profile name fragment
cb_gen_id() {
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr 'A-Z' 'a-z' | tr -d '-' | cut -c1-8
    else
        head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-8
    fi
}

# project root = git toplevel, else the given/current dir
cb_project_root() {
    local start="${1:-$PWD}"
    git -C "$start" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$start"
}

cb_project_config_path() { printf '%s/.claudebox/config.yml' "$1"; }

# wire the machine-local .claudebox files (config + secrets) into .gitignore, but
# only inside a real git repo — NEITHER may ever be committed (secrets.env holds
# credentials; config.yml is host-local VM sizing/identity).
cb_ensure_gitignore() {
    local root="$1" gi="$1/.gitignore" line
    [ -d "$root/.git" ] || return 0
    for line in /.claudebox/config.yml /.claudebox/secrets.env; do
        if [ -f "$gi" ]; then
            grep -qxF "$line" "$gi" 2>/dev/null || printf '%s\n' "$line" >> "$gi"
        else
            printf '%s\n' "$line" > "$gi"
        fi
    done
}

# ── project secrets (machine-local, gitignored, chmod 600) ───────────────────
# Source of truth is .claudebox/secrets.env (KEY=VALUE lines). It is injected into
# the container as env on every run and — crucially — persisted to a per-container
# sidecar the entrypoint re-reads on each start, so secrets survive `docker start`
# (which, unlike `docker run`, can't inject new env). A GH_TOKEN line = a claudebot
# that boots authenticated to GitHub with no interactive `gh auth login`.
cb_secrets_path() { printf '%s/.claudebox/secrets.env' "$1"; }  # $1=root; gitignored

# cb_secrets_put ROOT KEY VALUE — set/replace KEY in .claudebox/secrets.env (create
# with a header + chmod 600 if absent). Never echoes the value. Used by bootstrap
# --gh-token / --secrets-file; secrets are NEVER accepted on the command line.
cb_secrets_put() {
    local root="$1" key="$2" val="$3" sf tmp
    sf="$(cb_secrets_path "$root")"; mkdir -p "$(dirname "$sf")"
    if [ ! -f "$sf" ]; then
        printf '%s\n%s\n' \
            '# .claudebox/secrets.env — machine-local, gitignored, chmod 600. KEY=VALUE per line.' \
            '# Injected into the container as env on every run (survives restarts). NEVER commit.' > "$sf"
        chmod 600 "$sf"
    fi
    tmp="$(mktemp)"
    grep -vE "^[[:space:]]*${key}=" "$sf" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    cat "$tmp" > "$sf"; rm -f "$tmp"
    chmod 600 "$sf"
}

cb_write_sample() {
    cat > "$1/.claudebox/config.sample.yml" <<'CBSAMPLE'
# .claudebox/config.sample.yml — schema reference (committed).
# claudebox generates the real, gitignored .claudebox/config.yml on first run.
id: auto                  # stable project identity; generated once, never change
vm:
  cpu: 4
  memory: 8GiB
  disk: 60GiB
  autostop: false         # stop the VM when the harness container exits
network:
  hostname:               # optional /etc/hosts alias -> the VM's current IP; blank = raw IP
CBSAMPLE
}

# cb_init_project_config ROOT — ensure config + sample + gitignore; print the id.
cb_init_project_config() {
    local root="$1" cfg id cpu mem disk
    mkdir -p "$root/.claudebox"
    cfg="$(cb_project_config_path "$root")"
    [ -f "$cfg" ] && id="$(_cb_yaml_get "$cfg" id)"
    if [ -z "${id:-}" ] || [ "${id:-}" = "auto" ]; then
        id="$(cb_gen_id)"
        cpu="$(cb_machine_get vm.default_cpu)"
        mem="$(cb_machine_get vm.default_memory)"
        disk="$(cb_machine_get vm.default_disk)"
        cat > "$cfg" <<CBCONF
# .claudebox/config.yml — generated by claudebox; edit to taste. Gitignored.
id: $id
vm:
  cpu: $cpu
  memory: $mem
  disk: $disk
  autostop: false         # stop the VM when the harness container exits
network:
  hostname:               # optional /etc/hosts alias -> the VM's current IP; blank = raw IP
CBCONF
    fi
    cb_write_sample "$root"
    cb_ensure_gitignore "$root"
    printf '%s' "$id"
}

# cb_project_id ROOT — read the id, initializing config on first use
cb_project_id() {
    local root="$1" cfg id
    cfg="$(cb_project_config_path "$root")"
    if [ -f "$cfg" ]; then
        id="$(_cb_yaml_get "$cfg" id)"
        if [ -n "$id" ] && [ "$id" != "auto" ]; then printf '%s' "$id"; return 0; fi
    fi
    cb_init_project_config "$root"
}

# vm sizing with fallback: project config -> machine default -> baked default
cb_vm_get() {
    local root="$1" field="$2" v=""
    v="$(_cb_yaml_get "$(cb_project_config_path "$root")" "vm.$field")"
    if [ -z "$v" ]; then
        case "$field" in
            cpu)      v="$(cb_machine_get vm.default_cpu)" ;;
            memory)   v="$(cb_machine_get vm.default_memory)" ;;
            disk)     v="$(cb_machine_get vm.default_disk)" ;;
            autostop) v="$(cb_baked_default vm.autostop)" ;;
        esac
    fi
    printf '%s' "$v"
}

cb_project_profile()  { printf 'cb-%s' "$1"; }         # $1 = id
cb_project_context()  { printf 'colima-cb-%s' "$1"; }  # $1 = id
cb_project_data_dir() { printf '%s/%s/claude' "$(cb_data_root)" "$1"; }  # $1 = id

# read the project id WITHOUT creating config (empty if none) — for down/destroy
cb_project_id_ro() {
    local cfg
    cfg="$(cb_project_config_path "$1")"
    [ -f "$cfg" ] && _cb_yaml_get "$cfg" id
}

# ─────────────────────────────────────────────────────────────────────────────
# VM lifecycle — Phase 2 of docs/design/per-project-vm.md
#
# Pure helpers (cb_num, cb_guard_profile, cb_vm_limit_decision, cb_parse_vm_lines,
# cb_running_cb_profiles, cb_status_of) parse/decide from stdin or args and are
# unit-tested. The colima-calling glue (_cb_vm_list_json, cb_vm_status,
# cb_ensure_vm, cb_vm_down/destroy/ls) is exercised in integration.
# ─────────────────────────────────────────────────────────────────────────────

# strip a unit suffix to the bare number colima wants (8GiB -> 8, 60GiB -> 60)
cb_num() { local s="${1//[!0-9.]/}"; printf '%s' "${s:-0}"; }

# only ever act on a real claudebox profile — never 'default', never empty
cb_guard_profile() {
    case "${1:-}" in
        cb-?*) return 0 ;;
        *) printf 'refusing to operate on non-claudebox colima profile: %s\n' "${1:-<empty>}" >&2; return 1 ;;
    esac
}

# cb_vm_limit_decision COUNT WARN HARD -> ok | warn | deny
cb_vm_limit_decision() {
    local count="$1" warn="$2" hard="$3"
    case "$count$warn$hard" in *[!0-9]*) printf 'ok'; return 0 ;; esac
    if   [ "$count" -ge "$hard" ]; then printf 'deny'
    elif [ "$count" -ge "$warn" ]; then printf 'warn'
    else printf 'ok'; fi
}

# read `colima list --json` (JSON lines) on stdin -> "name<TAB>status" per VM.
# Field-order independent (matches "name"/"status" anywhere on the line).
cb_parse_vm_lines() {
    awk '{
        name=""; status="";
        if (match($0, /"name":"[^"]*"/))   name=substr($0, RSTART+8,  RLENGTH-9);
        if (match($0, /"status":"[^"]*"/)) status=substr($0, RSTART+10, RLENGTH-11);
        if (name != "") print name "\t" status;
    }'
}

# from "name<TAB>status" stdin -> names of running cb-* PROJECT profiles.
# cb-infra is the shared image-store VM, not a project — never counted/listed as one.
cb_running_cb_profiles() { awk -F'\t' '$1 ~ /^cb-/ && $1 != "cb-infra" && $2 == "Running" { print $1 }'; }

# from "name<TAB>status" stdin -> status of $1, or "absent"
cb_status_of() { awk -F'\t' -v p="$1" '$1==p { print $2; f=1 } END { if (!f) print "absent" }'; }

_cb_vm_list_json()    { colima list --json 2>/dev/null; }
cb_vm_status()        { _cb_vm_list_json | cb_parse_vm_lines | cb_status_of "$1"; }
cb_vm_running()       { [ "$(cb_vm_status "$1")" = "Running" ]; }
cb_running_cb_count() { _cb_vm_list_json | cb_parse_vm_lines | cb_running_cb_profiles | grep -c . ; }

# cb-infra: a dedicated colima profile that holds the locally-built image(s).
# make build / install.sh build into it; project VMs are seeded from it via
# save|load. This keeps the human's 'default' VM entirely untouched.
CB_INFRA_PROFILE="cb-infra"
cb_infra_context() { printf 'colima-%s' "$CB_INFRA_PROFILE"; }

# colima's LIMA_HOME — where per-profile lima instances and their named 'datadisk's
# live. `colima delete` removes the instance but LEAKS the datadisk, so we delete the
# disk ourselves (cb_vm_destroy) via limactl and need this path. Prefer an existing
# location; colima uses $COLIMA_HOME/_lima (XDG ~/.config/colima, legacy ~/.colima).
cb_lima_home() {
    local h
    for h in "${COLIMA_HOME:+$COLIMA_HOME/_lima}" \
             "${XDG_CONFIG_HOME:-$HOME/.config}/colima/_lima" \
             "$HOME/.colima/_lima"; do
        [ -n "$h" ] && [ -d "$h" ] && { printf '%s' "$h"; return 0; }
    done
    return 1
}

# `colima start` hijacks the global active docker context. We address every VM
# explicitly via `docker --context`, so restore the human's previously-active
# context afterward — otherwise their bare `docker` would silently point at a
# claudebox VM instead of `default`.
cb_colima_start() {
    local prev rc
    prev="$(docker context show 2>/dev/null)"
    colima start "$@"; rc=$?
    [ -n "$prev" ] && docker context use "$prev" >/dev/null 2>&1
    return $rc
}

# start cb-infra if it exists but isn't running (never creates it — that's `make build`)
cb_ensure_infra() {
    cb_vm_running "$CB_INFRA_PROFILE" && return 0
    if [ "$(cb_vm_status "$CB_INFRA_PROFILE")" = "absent" ]; then
        echo "❌ '$CB_INFRA_PROFILE' colima profile not found — build the image first: make build (or make build-minimal)" >&2
        return 1
    fi
    echo "🟢 starting '$CB_INFRA_PROFILE' VM (image store)..." >&2
    cb_colima_start -p "$CB_INFRA_PROFILE"
}

# Assert the image can be sourced from cb-infra: start cb-infra if it's stopped and
# confirm the image is actually present in it. cb-infra is the seed source for any
# project VM that doesn't already carry the image, so this doubles as a PRE-BOOT gate
# (see cb_ensure_vm) — verify it BEFORE spending minutes provisioning a project VM we
# could never populate.
cb_require_image_source() {
    cb_ensure_infra || return 1
    if ! docker --context "$(cb_infra_context)" image inspect "$CLAUDE_IMAGE" >/dev/null 2>&1; then
        echo "❌ $CLAUDE_IMAGE not present in $CB_INFRA_PROFILE — build it: make build (or make build-minimal)" >&2
        return 1
    fi
}

# seed $CLAUDE_IMAGE into a target docker context (save|load from cb-infra) if missing
cb_ensure_image() {
    local ctx="$1"
    docker --context "$ctx" image inspect "$CLAUDE_IMAGE" >/dev/null 2>&1 && return 0
    cb_require_image_source || return 1
    echo "📦 seeding $CLAUDE_IMAGE into project VM (one-time save|load)..." >&2
    docker --context "$(cb_infra_context)" save "$CLAUDE_IMAGE" | docker --context "$ctx" load >/dev/null
}

# cb_ensure_vm ROOT ID — start the project VM if needed (enforces limits), then
# make sure the claudebox image is present in it.
cb_ensure_vm() {
    local root="$1" id="$2" profile ctx cpu mem disk count warn hard decision status
    profile="$(cb_project_profile "$id")"
    ctx="$(cb_project_context "$id")"
    cb_guard_profile "$profile" || return 1
    status="$(cb_vm_status "$profile")"
    if [ "$status" != "Running" ]; then
        # A brand-new (absent) VM carries no image and can only be seeded from
        # cb-infra. Verify that source BEFORE the multi-minute provision so a missing
        # image fails fast instead of leaving an orphan VM running (the pre-fix
        # footgun). A merely-stopped VM may already hold the image — checked post-boot.
        if [ "$status" = "absent" ]; then
            cb_require_image_source || return 1
        fi
        count="$(cb_running_cb_count)"
        warn="$(cb_machine_get vm.warn_max)"
        hard="$(cb_machine_get vm.hard_max)"
        decision="$(cb_vm_limit_decision "$count" "$warn" "$hard")"
        case "$decision" in
            deny) echo "❌ $count claudebox VMs already running (hard_max=$hard). Free one with 'claudebox down' or 'claudebox destroy'." >&2; return 1 ;;
            warn) echo "⚠️  $count claudebox VMs running (warn_max=$warn); starting another." >&2 ;;
        esac
        cpu="$(cb_vm_get "$root" cpu)"
        mem="$(cb_vm_get "$root" memory)"
        disk="$(cb_vm_get "$root" disk)"
        local mount_args=()
        case "$root/" in
            "$HOME"/*) : ;;                        # under $HOME — colima auto-mounts it
            *) mount_args=(--mount "$root:w") ;;   # outside $HOME — mount it writable
        esac
        echo "🟢 starting colima VM '$profile' (cpu=$(cb_num "$cpu") mem=$(cb_num "$mem")GiB disk=$(cb_num "$disk")GiB)..." >&2
        # --network-address gives the VM a host-reachable IP so published workload
        # ports are browsable from the Mac (Phase 5). On the vz backend this needs
        # no sudo. cb-infra is just an image store and deliberately gets no IP.
        cb_colima_start -p "$profile" \
            --cpu "$(cb_num "$cpu")" --memory "$(cb_num "$mem")" --disk "$(cb_num "$disk")" \
            --network-address \
            "${mount_args[@]}" || return 1
    fi
    cb_ensure_image "$ctx" || return 1
}

cb_vm_down() {
    local profile; profile="$(cb_project_profile "$1")"
    cb_guard_profile "$profile" || return 1
    if [ "$(cb_vm_status "$profile")" = "absent" ]; then echo "no VM for this project ($profile)"; return 0; fi
    echo "⏹  stopping colima VM '$profile' (keeps disk; 'claudebox' restarts it)..."
    colima stop -p "$profile"
}

cb_vm_destroy() {
    local profile lh; profile="$(cb_project_profile "$1")"
    cb_guard_profile "$profile" || return 1
    if [ "$(cb_vm_status "$profile")" = "absent" ]; then
        echo "no VM for this project ($profile)"
    else
        echo "🗑  deleting colima VM '$profile' and all its containers/volumes..."
        colima delete -f -p "$profile"
    fi
    # colima delete LEAKS the per-profile lima datadisk (a whole sparse disk per
    # destroyed project VM — they pile up as ~GBs of dead weight). Remove it too.
    # Runs even when the VM was already absent, so it also reaps a previously-leaked
    # disk. limactl refuses an in-use disk, so this can't touch a live VM's disk.
    if command -v limactl >/dev/null 2>&1 && lh="$(cb_lima_home)"; then
        if LIMA_HOME="$lh" limactl disk delete "colima-$profile" >/dev/null 2>&1; then
            echo "   ✓ freed leaked lima datadisk (colima-$profile)"
        fi
    fi
}

cb_vm_ls() {
    local rows proj infra
    rows="$(_cb_vm_list_json | cb_parse_vm_lines)"
    proj="$(printf '%s\n' "$rows"  | awk -F'\t' '$1 ~ /^cb-/ && $1 != "cb-infra"')"
    infra="$(printf '%s\n' "$rows" | awk -F'\t' '$1 == "cb-infra" { print $2 }')"
    if [ -z "$proj" ]; then
        echo "no claudebox project VMs"
    else
        { printf 'PROFILE\tSTATUS\n'; printf '%s\n' "$proj"; } | column -t -s "$(printf '\t')"
    fi
    [ -n "$infra" ] && printf 'infra (cb-infra): %s\n' "$infra"
    return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Networking — Phase 5 of docs/design/per-project-vm.md
#
# Project VMs get a host-reachable IP (--network-address), so workloads that
# publish ports are browsable at http://<vm-ip>:<port> from the Mac — no port
# bands, no loopback pool. An optional per-project network.hostname maps to that
# IP via /etc/hosts, which the wrapper NEVER writes: it emits a paste-block for
# the human (no sudo from claudebox). Pure helpers below are unit-tested.
# ─────────────────────────────────────────────────────────────────────────────

# read `colima list --json` on stdin -> "name<TAB>address" (address empty if none)
cb_parse_vm_addr() {
    awk '{
        name=""; addr="";
        if (match($0, /"name":"[^"]*"/))    name=substr($0, RSTART+8,  RLENGTH-9);
        if (match($0, /"address":"[^"]*"/)) addr=substr($0, RSTART+11, RLENGTH-12);
        if (name != "") print name "\t" addr;
    }'
}

# from "name<TAB>address" stdin -> address of $1 (empty if none)
cb_addr_of() { awk -F'\t' -v p="$1" '$1==p { print $2; exit }'; }

# the project VM's reachable IP (empty if the VM has none / isn't up)
cb_vm_address() { _cb_vm_list_json | cb_parse_vm_addr | cb_addr_of "$1"; }

# Poll until the VM's reachable IP actually answers. The reachable interface
# (col0 / vmnet via bridge100 on the vz backend) lags `colima start
# --network-address` by a couple of seconds — there is no clean socket_vmnet/lima
# "ready" log to watch, so ICMP reachability is the signal. Don't fixed-sleep;
# poll. Echoes the ip once reachable (or best-effort ip after the timeout).
cb_wait_reachable() {   # $1=profile  $2=max_seconds (default 20)
    local profile="$1" max="${2:-20}" i=0 ip=""
    while [ "$i" -lt "$max" ]; do
        ip="$(cb_vm_address "$profile")"
        if [ -n "$ip" ] && timeout 2 ping -c1 "$ip" >/dev/null 2>&1; then printf '%s' "$ip"; return 0; fi
        sleep 1; i=$((i + 1))
    done
    printf '%s' "$ip"; return 1
}

# project network.hostname from config (empty/blank if unset)
cb_project_hostname() { _cb_yaml_get "$(cb_project_config_path "$1")" network.hostname; }

# the IP currently mapped to HOSTNAME in an /etc/hosts-style FILE (empty if none)
cb_hosts_ip() {
    [ -f "$1" ] || return 0
    awk -v h="$2" '
        /^[[:space:]]*#/ { next }
        { for (i = 2; i <= NF; i++) if ($i == h) { print $1; exit } }
    ' "$1"
}

# ok | missing | stale — compare desired IP against what /etc/hosts FILE has
cb_hosts_status() {
    local cur; cur="$(cb_hosts_ip "$1" "$2")"
    if   [ -z "$cur" ];      then printf 'missing'
    elif [ "$cur" = "$3" ];  then printf 'ok'
    else                          printf 'stale'; fi
}

# print how to reach the project VM's workloads; emit an /etc/hosts paste-block
# if a network.hostname is set but the host entry is missing/stale (never writes)
cb_network_info() {
    local root="$1" id="$2" profile ip host status line
    profile="$(cb_project_profile "$id")"
    # poll — the reachable IP lags VM start by a couple seconds
    ip="$(cb_wait_reachable "$profile")"
    if [ -z "$ip" ]; then
        echo "🌐 VM $profile has no reachable IP yet (is it running? try 'claudebox')."
        return 0
    fi
    echo "🌐 project VM $profile: $ip"
    echo "   browse a published workload at  http://$ip:<port>  (or http://localhost:<port>, colima-forwarded but collides across projects)"
    host="$(cb_project_hostname "$root")"
    if [ -z "$host" ]; then
        echo "   (set network.hostname in .claudebox/config.yml for a friendly name)"
        return 0
    fi
    line="$ip  $host"
    case "$(cb_hosts_status /etc/hosts "$host" "$ip")" in
        ok)      echo "   /etc/hosts: $host → $ip ✓   browse  http://$host:<port>" ;;
        missing) echo "   add to /etc/hosts (claudebox won't edit it — one-time, your call):"
                 echo "       echo \"$line\" | sudo tee -a /etc/hosts" ;;
        stale)   echo "   /etc/hosts has a STALE IP for $host — update that line to:"
                 echo "       $line" ;;
    esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Approach B (opt-in): CDP bridge to the human's real macOS Chrome
# See docs/design/browser-testing.md. A dedicated debug Chrome is driven by
# claudebot over the Chrome DevTools Protocol. CDP binds 127.0.0.1 only, so a tiny
# Python TCP forwarder (no socat/sudo dependency) republishes it on the Mac's
# reachable-network gateway (bridge100, 192.168.64.1) — reachable by the project
# VMs but NOT the LAN. Containers connect to it by IP (not hostname — Chrome
# rejects non-IP Host headers). Off by default; you run `browser-bridge up`.
# ─────────────────────────────────────────────────────────────────────────────
CB_CDP_PORT="${CLAUDEBOX_CDP_PORT:-9223}"                 # forwarder listen (Mac side)
CB_CDP_CHROME_PORT="${CLAUDEBOX_CDP_CHROME_PORT:-9222}"   # Chrome --remote-debugging-port
CB_CDP_BIND="${CLAUDEBOX_CDP_BIND:-192.168.64.1}"         # Mac reachable-net gateway (colima-only, not LAN)
cb_cdp_home() { printf '%s/claudebox/cdp' "$(cb_config_home)"; }
cb_cdp_marker() { printf '%s/claudebox/projects/%s/.cdp-url' "$(cb_config_home)" "$1"; }  # $1=id

# Shared cross-project sink for FRAMEWORK bug reports (cb-report-bug inside the
# container writes here; `claudebox framework-bugs` reads it). Deliberately shared
# across all projects — framework feedback spans projects, unlike per-project data.
cb_fwbugs_home() { printf '%s/claudebox/framework-bugs' "$(cb_config_home)"; }

cb_bridge_up() {   # $1=id
    local id="$1" chrome home profile fwd url
    chrome="${CLAUDEBOX_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
    [ -x "$chrome" ] || { echo "❌ Chrome not found at: $chrome (set CLAUDEBOX_CHROME)" >&2; return 1; }
    home="$(cb_cdp_home)"; mkdir -p "$home"; profile="$home/profile"; fwd="$home/forward.py"
    cat > "$fwd" <<PYEOF
import socket, threading
LISTEN=('$CB_CDP_BIND', $CB_CDP_PORT); DEST=('127.0.0.1', $CB_CDP_CHROME_PORT)
def pipe(a,b):
    try:
        while True:
            d=a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    finally:
        for s in (a,b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def handle(c):
    try: d=socket.create_connection(DEST)
    except OSError: c.close(); return
    threading.Thread(target=pipe,args=(c,d),daemon=True).start(); pipe(d,c)
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(LISTEN); s.listen(64)
while True:
    c,_=s.accept(); threading.Thread(target=handle,args=(c,),daemon=True).start()
PYEOF
    if [ -f "$home/pids" ] && kill -0 $(cat "$home/pids") 2>/dev/null; then
        echo "🔗 CDP bridge already running"
    else
        "$chrome" --remote-debugging-port="$CB_CDP_CHROME_PORT" --user-data-dir="$profile" \
            --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
        local cpid=$!
        sleep 2
        python3 "$fwd" >"$home/forward.log" 2>&1 &
        local fpid=$!
        echo "$cpid $fpid" > "$home/pids"
    fi
    url="http://$CB_CDP_BIND:$CB_CDP_PORT"
    local marker; marker="$(cb_cdp_marker "$id")"; mkdir -p "$(dirname "$marker")"; printf '%s' "$url" > "$marker"
    echo "🔗 CDP bridge up — a dedicated debug Chrome window is open; claudebot can drive it."
    echo "   in claudebot:  cb-browser cdp <url>   (uses CLAUDEBOX_HOST_CDP_URL=$url)"
    echo "   restart the claudebox session so the container picks up the bridge URL."
    echo "   stop:  claudebox browser-bridge down"
    echo "   ⚠️  this hands claudebot full control of that Chrome instance (dedicated profile)."
}

cb_bridge_down() {  # $1=id
    local id="$1" home; home="$(cb_cdp_home)"
    [ -f "$home/pids" ] && { kill $(cat "$home/pids") 2>/dev/null; rm -f "$home/pids"; }
    rm -f "$(cb_cdp_marker "$id")"
    echo "🔗 CDP bridge down"
}

# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap — hand off *intent* from host-Claude into a new claudebot project.
# See docs/design/bootstrap.md. `claudebox bootstrap` scaffolds a project and
# writes a durable, COMMITTED mission brief (.claudebox/BRIEF.md) so claudebot
# boots knowing WHY it was created. Full scaffolder by default; --brief-only for
# just the brief + config.
# ─────────────────────────────────────────────────────────────────────────────
cb_brief_path() { printf '%s/.claudebox/BRIEF.md' "$1"; }  # $1=root; COMMITTED (unlike config.yml)

# cb_preflight MODE — assert the host tooling a claudebot project needs is in place
# BEFORE we scaffold or boot. HARD requirements (colima, docker; git for full mode)
# abort; recommended tools (python3, socket_vmnet) only warn. This is the "check the
# ground before building on it" gate. Override with CLAUDEBOX_SKIP_PREFLIGHT=1.
cb_preflight() {
    local mode="${1:-full}" missing=0 t
    [ -n "${CLAUDEBOX_SKIP_PREFLIGHT:-}" ] && return 0
    echo "preflight — host tooling:"
    for t in colima docker; do
        if command -v "$t" >/dev/null 2>&1; then echo "  ✓ $t"
        else echo "  ✗ $t — REQUIRED (MacPorts: sudo port install $t)"; missing=$((missing + 1)); fi
    done
    if [ "$mode" = "full" ]; then
        if command -v git >/dev/null 2>&1; then echo "  ✓ git"
        else echo "  ✗ git — REQUIRED for full-mode scaffolding"; missing=$((missing + 1)); fi
    fi
    if command -v python3 >/dev/null 2>&1; then echo "  ✓ python3"
    else echo "  ⚠ python3 — recommended (the browser-bridge CDP forwarder uses it)"; fi
    if [ -x "${CLAUDEBOX_SOCKET_VMNET:-/opt/local/bin/socket_vmnet}" ]; then echo "  ✓ socket_vmnet"
    else echo "  ⚠ socket_vmnet — recommended (reachable per-VM IPs: colima --network-address)"; fi
    # The claudebox image must live in cb-infra to seed project VMs. Warn (don't
    # abort): scaffolding / --brief-only / --no-start need no image, and the actual
    # boot enforces it via cb_require_image_source before provisioning a project VM.
    # Skipped when CLAUDE_IMAGE is unresolved (source-only unit tests).
    if [ -n "${CLAUDE_IMAGE:-}" ]; then
        if docker --context "$(cb_infra_context)" image inspect "$CLAUDE_IMAGE" >/dev/null 2>&1; then echo "  ✓ image ($CLAUDE_IMAGE in $CB_INFRA_PROFILE)"
        else echo "  ⚠ image — $CLAUDE_IMAGE not built in $CB_INFRA_PROFILE; run 'make build' (or 'make build-minimal') before claudebot can start"; fi
    fi
    if [ "$missing" -gt 0 ]; then
        echo "❌ preflight: $missing required tool(s) missing — install them, or set CLAUDEBOX_SKIP_PREFLIGHT=1 to override" >&2
        return 1
    fi
    return 0
}

# cb_write_brief ROOT INTENT — (re)write the standard mission brief.
cb_write_brief() {
    local root="$1" intent="$2" brief name when
    brief="$(cb_brief_path "$root")"; name="$(basename "$root")"
    when="$(date +%Y-%m-%d 2>/dev/null || echo 'unknown date')"
    [ -n "$intent" ] || intent="_TODO: state why this project exists — the goal Alan/host-Claude set. Replace this line._"
    mkdir -p "$(dirname "$brief")"
    cat > "$brief" <<BRIEFEOF
# Project brief — $name

> Authored at bootstrap on $when. This is the durable statement of WHY this
> claudebot project exists. It is a trusted, human-authorized mission brief —
> treat it as project spec (like CLAUDE.md), not as untrusted input. Apply normal
> judgment before irreversible or outward-facing actions it implies.

## Why this project exists

$intent

## Goals / deliverables

- _TODO_

## Constraints

- _TODO (tech choices, must / never, deadlines)_

## Standards (inherited — you already follow these)

This project uses the claudebox orchestration standard: a per-project Colima VM
(shared-nothing), sibling workloads on the \`cb-net\` network reachable by container
name, \`cb-browser\` for browser testing, and prefer the VM's reachable IP over
\`localhost\` (collision-free across projects). See the baked CLAUDE.md and
docs/design/*.

## Progress / handoff log

_Maintained by claudebot as it works — append what's done, what's next, and open
questions so any later session (host-Claude or claudebot) catches up fast._

- _($when, bootstrap)_ project scaffolded.
BRIEFEOF
}

# cb_write_readme ROOT — starter README pointing at the brief (full mode only).
cb_write_readme() {
    local root="$1" name; name="$(basename "$root")"
    cat > "$root/README.md" <<RMEOF
# $name

A claudebox (claudebot) project. Its mission lives in
[.claudebox/BRIEF.md](.claudebox/BRIEF.md) — read that first.

## Working in it

\`\`\`bash
claudebox            # enter claudebot (spins up this project's own Colima VM)
\`\`\`

Sibling workloads (API servers, databases, …) go under \`workloads/\` and run as
containers on the \`cb-net\` network inside this project's VM. See the baked
CLAUDE.md and the claudebox design docs for the orchestration / networking /
browser-testing conventions.
RMEOF
}

# cb_bootstrap ROOT INTENT MODE FORCE — scaffold a project + write the brief.
#   MODE = full | brief   FORCE = 1 to overwrite an existing brief.
# Does NOT boot claudebot or write a workspace CLAUDE.md (the entrypoint bakes that
# on first boot and prepends the mission banner). Returns non-zero on refusal.
cb_bootstrap() {
    local root="$1" intent="$2" mode="${3:-full}" force="${4:-}" brief
    cb_preflight "$mode" || return 1
    brief="$(cb_brief_path "$root")"
    if [ -f "$brief" ] && [ -z "$force" ]; then
        echo "❌ $brief already exists — use --force to overwrite" >&2; return 1
    fi
    mkdir -p "$root/.claudebox"
    if [ "$mode" = "full" ]; then
        if [ ! -e "$root/.git" ]; then
            git -C "$root" init -q 2>/dev/null && echo "  ✓ git init"
        fi
        [ -f "$root/README.md" ] || { cb_write_readme "$root"; echo "  ✓ README.md"; }
        mkdir -p "$root/workloads"
        [ -e "$root/workloads/.gitkeep" ] || : > "$root/workloads/.gitkeep"
    fi
    cb_write_brief "$root" "$intent";              echo "  ✓ .claudebox/BRIEF.md (committed)"
    cb_init_project_config "$root" >/dev/null;     echo "  ✓ .claudebox/config.yml (gitignored)"
    echo "🚀 bootstrapped: $(basename "$root")"
}

# load functions only (for tests) without running the wrapper body
[ -n "${CLAUDEBOX_SOURCE_ONLY:-}" ] && return 0 2>/dev/null || true

DEBUG="${CLAUDEBOX_ENV_DEBUG:-${DEBUG:-}}"

dbg() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG $(date +%H:%M:%S.%3N)] $*" >&2; }

# This fork uses a locally-built image (see install.sh / `make build`), NOT the
# upstream psyb0t/claudebox on Docker Hub. The bare repo name has no registry
# prefix, so Docker never tries to pull it — a missing image is a hard error,
# which is what we want (build it locally first). Override with CLAUDEBOX_IMAGE.
CLAUDE_IMAGE="${CLAUDEBOX_IMAGE:-${CLAUDE_IMAGE:-}}"
CLAUDE_IMAGE_NAME="${CLAUDEBOX_IMAGE_NAME:-claudebox}"
_minimal="${CLAUDEBOX_MINIMAL:-${CLAUDE_MINIMAL:-}}"
if [ -z "$CLAUDE_IMAGE" ]; then
    if [ -n "$_minimal" ]; then
        CLAUDE_IMAGE="${CLAUDE_IMAGE_NAME}:latest-minimal"
    else
        CLAUDE_IMAGE="${CLAUDE_IMAGE_NAME}:latest"
    fi
fi

CLAUDE_GIT_NAME="${CLAUDEBOX_GIT_NAME:-${CLAUDE_GIT_NAME:-}}"
CLAUDE_GIT_EMAIL="${CLAUDEBOX_GIT_EMAIL:-${CLAUDE_GIT_EMAIL:-}}"
# Per-project shared-nothing data dir (Phase 3 of docs/design/per-project-vm.md).
# An explicit CLAUDEBOX_DATA_DIR / CLAUDE_DATA_DIR override still wins; otherwise
# CLAUDE_DIR is resolved per project after the VM subcommands (needs the id).
CLAUDE_DIR="${CLAUDEBOX_DATA_DIR:-${CLAUDE_DATA_DIR:-}}"
CLAUDE_SSH="${CLAUDEBOX_SSH_DIR:-${CLAUDE_SSH_DIR:-$HOME/.ssh/claudebox}}"

# auth: prefer CLAUDEBOX_ENV_*, fall back to legacy direct vars
ANTHROPIC_API_KEY="${CLAUDEBOX_ENV_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"
CLAUDE_CODE_OAUTH_TOKEN="${CLAUDEBOX_ENV_CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}"

# Normalize to the PHYSICAL workspace path, resolving symlinks (notably macOS
# /tmp -> /private/tmp). Lima shares the resolved path into the VM (it uses the git
# toplevel / realpath), so the container bind-mount (-v $PWD:$PWD) and WORKSPACE
# must use that same resolved path — otherwise the workspace mounts EMPTY inside the
# VM (the symlinked path doesn't exist there) and claudebot can't see its files.
# A no-op for paths with no symlinks (e.g. under $HOME).
cd -P "$PWD" 2>/dev/null || true
dbg "PWD (physical)=$PWD"

# Convert PWD to a valid container name (slashes to underscores)
sanitized_pwd=$(echo "$PWD" | sed 's/\//_/g')
container_name="${CLAUDEBOX_CONTAINER_NAME:-${CLAUDE_CONTAINER_NAME:-claude-${sanitized_pwd}}}"
dbg "container_name=$container_name"
dbg "CLAUDE_DIR=$CLAUDE_DIR"
dbg "CLAUDE_SSH=$CLAUDE_SSH"
dbg "PWD=$PWD"

# ── per-project VM subcommands (Phase 2 of docs/design/per-project-vm.md) ─────
# Act on the project's colima VM and exit before any container/auth setup.
CB_PROJECT_ROOT="$(cb_project_root "$PWD")"
dbg "CB_PROJECT_ROOT=$CB_PROJECT_ROOT"
case "${1:-}" in
    vm)
        case "${2:-}" in
            ls|list|"") cb_vm_ls; exit 0 ;;
            *) echo "usage: claudebox vm ls" >&2; exit 1 ;;
        esac
        ;;
    down)
        _cbid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
        if [ -z "$_cbid" ]; then echo "no claudebox VM for this project (no .claudebox/config.yml)"; exit 0; fi
        cb_vm_down "$_cbid"; exit $?
        ;;
    destroy)
        _cbid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
        if [ -z "$_cbid" ]; then echo "no claudebox VM for this project (no .claudebox/config.yml)"; exit 0; fi
        cb_vm_destroy "$_cbid"; exit $?
        ;;
    browser-bridge)
        _cbid="$(cb_project_id "$CB_PROJECT_ROOT")"
        case "${2:-}" in
            up)   cb_bridge_up "$_cbid"; exit $? ;;
            down) cb_bridge_down "$_cbid"; exit $? ;;
            *)    echo "usage: claudebox browser-bridge up|down  (opt-in: let claudebot drive your real Chrome via CDP)" >&2; exit 1 ;;
        esac
        ;;
    framework-bugs)
        # review FRAMEWORK bug reports claudebot filed via cb-report-bug (any project)
        _fwb="$(cb_fwbugs_home)"
        case "${2:-list}" in
            list)
                shopt -s nullglob; _reports=("$_fwb"/*.md); shopt -u nullglob
                if [ "${#_reports[@]}" -eq 0 ]; then
                    echo "no framework bug reports in $_fwb"
                else
                    echo "framework bug reports (${#_reports[@]}) in $_fwb:"
                    for _r in "${_reports[@]}"; do
                        printf '  - %s\n      %s\n' "$(basename "$_r")" "$(grep -m1 '^# ' "$_r" | sed 's/^# //')"
                    done
                    echo ""; echo "view one:  cat \"$_fwb\"/<file>     clear all:  claudebox framework-bugs clear"
                fi ;;
            clear) rm -f "$_fwb"/*.md 2>/dev/null; echo "cleared framework bug reports in $_fwb" ;;
            *)     echo "usage: claudebox framework-bugs [list|clear]" >&2; exit 1 ;;
        esac
        exit 0
        ;;
    claude-dir)
        # print the host .claude data dir for THIS project (read-only; no config init,
        # no VM). Authoritative — respects a CLAUDEBOX_DATA_DIR override and the
        # machine data_root. Used by the cbx-claude-dir shell helper.
        _dd="${CLAUDEBOX_DATA_DIR:-${CLAUDE_DATA_DIR:-}}"
        if [ -n "$_dd" ]; then
            printf '%s\n' "$_dd"
        else
            _cbid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
            [ -n "$_cbid" ] || { echo "no claudebox project here (.claudebox/config.yml missing)" >&2; exit 1; }
            printf '%s\n' "$(cb_project_data_dir "$_cbid")"
        fi
        exit 0
        ;;
    bootstrap)
        # scaffold a new claudebot project in $PWD + write the mission brief.
        shift
        _bs_mode=full _bs_force= _bs_start=1 _bs_intent= _bs_file= _bs_secfile= _bs_ghtoken=
        while [ $# -gt 0 ]; do
            case "$1" in
                --brief-only) _bs_mode=brief; _bs_start= ;;
                --no-start)   _bs_start= ;;
                --force)      _bs_force=1 ;;
                --brief-file) _bs_file="${2:-}"; shift ;;
                --secrets-file) _bs_secfile="${2:-}"; shift ;;
                --gh-token)   _bs_ghtoken=1 ;;
                -h|--help)
                    echo "usage: claudebox bootstrap [--brief-only] [--no-start] [--force] [--brief-file F]"
                    echo "                           [--secrets-file F] [--gh-token] [\"intent…\"]"
                    echo "  scaffold a claudebot project in the current directory + write .claudebox/BRIEF.md."
                    echo "  intent comes from the arg, --brief-file, or stdin. Default boots claudebot after."
                    echo ""
                    echo "  secrets (never typed on the command line — file-based only):"
                    echo "    --secrets-file F  merge KEY=VALUE lines from F into .claudebox/secrets.env"
                    echo "    --gh-token        seed GH_TOKEN from the host's own 'gh auth token' (boot authed to GitHub)"
                    echo "  secrets.env is gitignored + chmod 600 and injected into claudebot as env each run."
                    exit 0 ;;
                --) shift; break ;;
                -*) echo "bootstrap: unknown flag '$1'" >&2; exit 1 ;;
                *)  _bs_intent="$1" ;;
            esac
            shift
        done
        if [ -n "$_bs_file" ]; then
            [ -f "$_bs_file" ] || { echo "bootstrap: --brief-file not found: $_bs_file" >&2; exit 1; }
            _bs_intent="$(cat "$_bs_file")"
        elif [ -z "$_bs_intent" ] && [ ! -t 0 ]; then
            _bs_intent="$(cat)"   # piped/heredoc intent (host-Claude path)
        fi
        cb_bootstrap "$PWD" "$_bs_intent" "$_bs_mode" "$_bs_force" || exit $?
        # secrets: file-based only, so nothing sensitive is echoed or shell-history'd.
        if [ -n "$_bs_secfile" ]; then
            [ -f "$_bs_secfile" ] || { echo "bootstrap: --secrets-file not found: $_bs_secfile" >&2; exit 1; }
            _sn=0
            while IFS='=' read -r _k _v; do
                case "$_k" in ''|\#*) continue ;; esac
                cb_secrets_put "$PWD" "$_k" "$_v"; _sn=$((_sn + 1))
            done < "$_bs_secfile"
            echo "  ✓ .claudebox/secrets.env ($_sn key(s) from $_bs_secfile; gitignored, chmod 600)"
        fi
        if [ -n "$_bs_ghtoken" ]; then
            _tok="$(gh auth token 2>/dev/null)"
            if [ -n "$_tok" ]; then
                cb_secrets_put "$PWD" GH_TOKEN "$_tok"
                echo "  ✓ .claudebox/secrets.env: GH_TOKEN (from host 'gh auth token'; gitignored, chmod 600)"
            else
                echo "  ⚠ --gh-token: host 'gh auth token' returned nothing — run 'gh auth login' on the Mac first; skipped" >&2
            fi
        fi
        if [ -n "$_bs_start" ]; then
            echo "  ▶ starting claudebot…"
            exec "$0"   # re-enter the wrapper normally → boots the VM + claudebot with the brief
        fi
        echo "  (not started) enter later with:  cd $(printf '%q' "$PWD") && claudebox"
        exit 0
        ;;
esac

# ── project identity → colima context (Phase 4) ──────────────────────────────
# Every docker call below runs against the project's own VM via `"${DOCKER[@]}"`.
CB_PROJECT_ID="$(cb_project_id "$CB_PROJECT_ROOT")"
CB_CONTEXT="$(cb_project_context "$CB_PROJECT_ID")"
DOCKER=(docker --context "$CB_CONTEXT")
dbg "project id=$CB_PROJECT_ID context=$CB_CONTEXT"

# ── resolve the per-project data dir (shared-nothing) unless overridden ───────
# Each project gets its own ~/.claude state under ~/.config/claudebox/projects/<id>.
# Auth is not project state — it still arrives per invocation via env (below) and
# is written into this dir, so there is no shared mutable directory.
if [ -z "$CLAUDE_DIR" ]; then
    CLAUDE_DIR="$(cb_project_data_dir "$CB_PROJECT_ID")"
    dbg "per-project data dir: $CLAUDE_DIR"
else
    dbg "data dir override: $CLAUDE_DIR"
fi
mkdir -p "$CLAUDE_DIR"

DOCKER_ARGS=(
    --network host
    -e CLAUDEBOX_GIT_NAME="$CLAUDE_GIT_NAME"
    -e CLAUDEBOX_GIT_EMAIL="$CLAUDE_GIT_EMAIL"
    -e CLAUDEBOX_WORKSPACE="$PWD"
    -e CLAUDEBOX_CONTAINER_NAME="$container_name"
    -v "$CLAUDE_SSH:/home/claude/.ssh"
    -v "$CLAUDE_DIR:/home/claude/.claude"
    -v "$PWD:$PWD"
    -v /var/run/docker.sock:/var/run/docker.sock
)

# Approach B: if a CDP bridge is up for this project, inject its URL so claudebot
# can drive the human's Chrome (cb-browser cdp). Marker written by browser-bridge up.
_cdp_marker="$(cb_cdp_marker "$CB_PROJECT_ID")"
if [ -f "$_cdp_marker" ]; then
    DOCKER_ARGS+=(-e "CLAUDEBOX_HOST_CDP_URL=$(cat "$_cdp_marker")")
    dbg "CDP bridge URL injected: $(cat "$_cdp_marker")"
fi

# Shared framework-bug drop dir — mount it into every container so cb-report-bug can
# file suspected FRAMEWORK bugs (wrapper/entrypoint/image/networking) to one place.
_fwbugs="$(cb_fwbugs_home)"; mkdir -p "$_fwbugs" 2>/dev/null || true
DOCKER_ARGS+=(-v "$_fwbugs:/home/claude/framework-bugs")
DOCKER_ARGS+=(-e "CLAUDEBOX_FRAMEWORK_BUGS_DIR=/home/claude/framework-bugs")
DOCKER_ARGS+=(-e "CLAUDEBOX_PROJECT_ID=$CB_PROJECT_ID")
_fwb_n=$(find "$_fwbugs" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "${_fwb_n:-0}" -gt 0 ] && echo "⚠ $_fwb_n framework bug report(s) on file — review: claudebox framework-bugs" >&2

# forward env vars to the container
[ -n "$ANTHROPIC_API_KEY" ] && DOCKER_ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && DOCKER_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
[ "$DEBUG" = "true" ] && DOCKER_ARGS+=(-e "DEBUG=true")
# opt out of the baked default plugin set (entrypoint seeds settings.json otherwise)
[ -n "${CLAUDEBOX_DEFAULT_PLUGINS:-}" ] && DOCKER_ARGS+=(-e "CLAUDEBOX_DEFAULT_PLUGINS=$CLAUDEBOX_DEFAULT_PLUGINS")


# forward CLAUDEBOX_ENV_* / CLAUDE_ENV_* vars (strip prefix: FOO=bar)
while IFS='=' read -r name value; do
    case "$name" in
        CLAUDEBOX_ENV_*) stripped="${name#CLAUDEBOX_ENV_}" ;;
        CLAUDE_ENV_*)    stripped="${name#CLAUDE_ENV_}" ;;
        *) continue ;;
    esac
    DOCKER_ARGS+=(-e "$stripped=$value")
    dbg "forwarding env: $stripped"
done < <(env | grep -E "^(CLAUDEBOX_ENV_|CLAUDE_ENV_)")

# mount extra volumes via CLAUDEBOX_MOUNT_* / CLAUDE_MOUNT_*
while IFS='=' read -r name value; do
    case "$value" in
        *:*) DOCKER_ARGS+=(-v "$value") ;;
        *)   DOCKER_ARGS+=(-v "$value:$value") ;;
    esac
    dbg "mounting volume: $value"
done < <(env | grep -E "^(CLAUDEBOX_MOUNT_|CLAUDE_MOUNT_)")

dbg "ANTHROPIC_API_KEY set: $([ -n "$ANTHROPIC_API_KEY" ] && echo yes || echo no)"
dbg "CLAUDE_CODE_OAUTH_TOKEN set: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo yes || echo no)"
AUTH_CONTENT=$(printf '%s\n' "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}")
echo "$AUTH_CONTENT" > "$CLAUDE_DIR/.${container_name}-auth"
chmod 600 "$CLAUDE_DIR/.${container_name}-auth"
echo "$AUTH_CONTENT" > "$CLAUDE_DIR/.${container_name}_prog-auth"
chmod 600 "$CLAUDE_DIR/.${container_name}_prog-auth"
echo "$AUTH_CONTENT" > "$CLAUDE_DIR/.${container_name}_cron-auth"
chmod 600 "$CLAUDE_DIR/.${container_name}_cron-auth"
dbg "wrote auth files"

# ── inject machine-local project secrets (.claudebox/secrets.env) ────────────
# (a) forward each KEY=VALUE as env for THIS run and (b) persist to per-container
# sidecars the entrypoint re-reads on every start — so secrets survive `docker
# start` (which can't take new env). Same durable pattern as the auth files above.
SECRETS_SRC="$(cb_secrets_path "$CB_PROJECT_ROOT")"
if [ -f "$SECRETS_SRC" ]; then
    while IFS='=' read -r _sname _sval; do
        case "$_sname" in ''|\#*) continue ;; esac
        DOCKER_ARGS+=(-e "$_sname=$_sval")
        dbg "forwarding secret: $_sname"
    done < "$SECRETS_SRC"
    for _srole in "" _prog _cron; do
        cp "$SECRETS_SRC" "$CLAUDE_DIR/.${container_name}${_srole}-secrets"
        chmod 600 "$CLAUDE_DIR/.${container_name}${_srole}-secrets"
    done
    dbg "wrote secrets sidecars from $SECRETS_SRC"
fi

# updates are disabled by default; pass --update to opt in
DO_UPDATE=0
REMAINING_ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--update" ]; then
        DO_UPDATE=1
        continue
    fi
    REMAINING_ARGS+=("$arg")
done
set -- "${REMAINING_ARGS[@]}"

# setup-token — throwaway container, token is saved to mounted ~/.claude
if [ "${1:-}" = "setup-token" ]; then
    cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
    "${DOCKER[@]}" run -it --rm --name "${container_name}_setup_$$" "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE setup-token
    exit 0
fi

# stop — kill running interactive container for this workspace (no VM boot: a
# stopped VM means nothing is running)
if [ "${1:-}" = "stop" ]; then
    if ! cb_vm_running "$(cb_project_profile "$CB_PROJECT_ID")"; then
        echo "nothing running (VM not up)"
    elif "${DOCKER[@]}" ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        "${DOCKER[@]}" stop "$container_name" >/dev/null 2>&1
        echo "stopped $container_name"
    else
        echo "nothing running"
    fi
    exit 0
fi

# clear-session — remove project session files for current workspace
if [ "${1:-}" = "clear-session" ]; then
    project_path=$(echo "$PWD" | sed 's|/|-|g')
    project_dir="$CLAUDE_DIR/projects/${project_path}"
    if [ -d "$project_dir" ]; then
        rm -rf "$project_dir"
        echo "cleared session for $PWD"
    else
        echo "no session found for $PWD (looked in $project_dir)"
    fi
    exit 0
fi

# ip / net — show the project VM's reachable IP + how to browse workloads
if [ "${1:-}" = "ip" ] || [ "${1:-}" = "net" ]; then
    cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
    cb_network_info "$CB_PROJECT_ROOT" "$CB_PROJECT_ID"
    exit 0
fi

# cron mode — long-running daemon container, named <base>_cron
_mode_cron="${CLAUDEBOX_MODE_CRON:-${CLAUDE_MODE_CRON:-}}"
_mode_cron_file="${CLAUDEBOX_MODE_CRON_FILE:-${CLAUDE_MODE_CRON_FILE:-}}"
if [ -n "$_mode_cron" ]; then
    cron_name="${container_name}_cron"
    dbg "cron container: $cron_name"

    if [ "${1:-}" = "stop" ]; then
        if cb_vm_running "$(cb_project_profile "$CB_PROJECT_ID")" \
            && "${DOCKER[@]}" ps --format '{{.Names}}' | grep -q "^${cron_name}$"; then
            "${DOCKER[@]}" stop "$cron_name" >/dev/null 2>&1
            echo "stopped $cron_name"
        else
            echo "cron not running"
        fi
        exit 0
    fi

    cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1

    if "${DOCKER[@]}" ps --format '{{.Names}}' | grep -q "^${cron_name}$"; then
        echo "cron already running ($cron_name)"
        echo "  docker --context $CB_CONTEXT logs -f $cron_name"
        exit 0
    fi

    CRON_ARGS=(
        -e "CLAUDEBOX_MODE_CRON=1"
        -e "CLAUDEBOX_WORKSPACE=$PWD"
        -e "CLAUDEBOX_CONTAINER_NAME=$cron_name"
    )
    [ -n "$_mode_cron_file" ] && CRON_ARGS+=(-e "CLAUDEBOX_MODE_CRON_FILE=$_mode_cron_file")
    [ "$DEBUG" = "true" ]     && CRON_ARGS+=(-e "DEBUG=true")

    if "${DOCKER[@]}" ps -a --format '{{.Names}}' | grep -q "^${cron_name}$"; then
        echo "restarting cron container ($cron_name)..."
        "${DOCKER[@]}" start "$cron_name"
    else
        echo "starting cron container ($cron_name)..."
        "${DOCKER[@]}" run -d --name "$cron_name" "${DOCKER_ARGS[@]}" "${CRON_ARGS[@]}" $CLAUDE_IMAGE
    fi
    echo "  docker --context $CB_CONTEXT logs -f $cron_name"
    exit 0
fi

# passthrough commands — run in throwaway container, bypass entrypoint
case "${1:-}" in
    -v|--version|doctor|auth|mcp)
        cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
        "${DOCKER[@]}" run --rm --entrypoint claude "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE "$@"
        exit 0
        ;;
esac

# Parse and validate args
if [ $# -gt 0 ]; then
    NEEDS_VERBOSE=0
    HAS_OUTPUT_FORMAT=0
    HAS_PROMPT=0
    HAS_PRINT=0
    HAS_NO_CONTINUE=0
    JSON_VERBOSE=0
    PASS_ARGS=(-p)
    EXPECT_VALUE=""
    for arg in "$@"; do
        if [ -n "$EXPECT_VALUE" ]; then
            case "$EXPECT_VALUE" in
                --output-format)
                    HAS_OUTPUT_FORMAT=1
                    case "$arg" in
                        text|json) ;;
                        stream-json) NEEDS_VERBOSE=1 ;;
                        json-verbose) JSON_VERBOSE=1; NEEDS_VERBOSE=1 ;;
                        *) echo "❌ Invalid output format: $arg (allowed: text, json, json-verbose, stream-json)"; exit 1 ;;
                    esac
                    ;;
                --model|--system-prompt|--append-system-prompt|--json-schema|--effort|--resume) ;;
            esac
            PASS_ARGS+=("$EXPECT_VALUE" "$arg")
            EXPECT_VALUE=""
            continue
        fi

        case "$arg" in
            -p|--print)
                HAS_PRINT=1
                ;;
            --no-continue)
                HAS_NO_CONTINUE=1
                PASS_ARGS+=("$arg")
                ;;
            --output-format|--model|--system-prompt|--append-system-prompt|--json-schema|--effort|--resume)
                EXPECT_VALUE="$arg"
                ;;
            --output-format=*)
                HAS_OUTPUT_FORMAT=1
                fmt="${arg#--output-format=}"
                case "$fmt" in
                    text|json) ;;
                    stream-json) NEEDS_VERBOSE=1 ;;
                    json-verbose) JSON_VERBOSE=1; NEEDS_VERBOSE=1 ;;
                    *) echo "❌ Invalid output format: $fmt (allowed: text, json, json-verbose, stream-json)"; exit 1 ;;
                esac
                PASS_ARGS+=("$arg")
                ;;
            --model=*|--system-prompt=*|--append-system-prompt=*|--json-schema=*|--effort=*|--resume=*)
                PASS_ARGS+=("$arg")
                ;;
            -*)
                echo "❌ Unknown flag: $arg (allowed: -p, --print, --output-format, --model, --system-prompt, --append-system-prompt, --json-schema, --effort, --resume, --no-continue, --update)"
                exit 1
                ;;
            *)
                if [ "$HAS_PRINT" = "0" ]; then
                    echo "❌ Unknown command: $arg"
                    echo "   Use -p or --print for programmatic mode: claude -p \"your prompt\""
                    exit 1
                fi
                # positional arg = prompt
                HAS_PROMPT=1
                PASS_ARGS+=("$arg")
                ;;
        esac
    done

    if [ -n "$EXPECT_VALUE" ]; then
        echo "❌ Missing value for $EXPECT_VALUE"
        exit 1
    fi

    if [ "$HAS_PROMPT" = "1" ]; then
        [ "$NEEDS_VERBOSE" = "1" ] && PASS_ARGS+=(--verbose)

        # determine pipe mode and fix args for json-verbose
        PIPE_MODE=""
        if [ "$HAS_OUTPUT_FORMAT" = "0" ]; then
            PASS_ARGS+=(--output-format text)
        elif [ "$JSON_VERBOSE" = "1" ]; then
            PIPE_MODE="json-verbose"
            FIXED_ARGS=()
            for a in "${PASS_ARGS[@]}"; do
                case "$a" in
                    json-verbose) FIXED_ARGS+=(stream-json) ;;
                    --output-format=json-verbose) FIXED_ARGS+=(--output-format=stream-json) ;;
                    *) FIXED_ARGS+=("$a") ;;
                esac
            done
            PASS_ARGS=("${FIXED_ARGS[@]}")
        else
            # detect json or stream-json in args
            for a in "${PASS_ARGS[@]}"; do
                case "$a" in
                    json|--output-format=json) PIPE_MODE="json" ;;
                    stream-json|--output-format=stream-json) PIPE_MODE="stream-json" ;;
                esac
            done
        fi

        dbg "PASS_ARGS: ${PASS_ARGS[*]}"
        dbg "PIPE_MODE: $PIPE_MODE"

        cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1

        # Programmatic mode — own container, no TTY
        prog_name="${container_name}_prog"
        dbg "prog container: $prog_name"
        prog_rc=0
        if ! "${DOCKER[@]}" ps -a --format '{{.Names}}' | grep -q "^${prog_name}$"; then
            dbg "prog: container does not exist, creating with docker run"
            if [ -n "$PIPE_MODE" ]; then
                "${DOCKER[@]}" run --name "$prog_name" "${DOCKER_ARGS[@]}" -e CLAUDEBOX_CONTAINER_NAME="$prog_name" $CLAUDE_IMAGE "${PASS_ARGS[@]}" \
                    | "${DOCKER[@]}" run --rm -i --entrypoint python3 $CLAUDE_IMAGE /home/claude/jsonpipe.py "$PIPE_MODE"
                prog_rc=${PIPESTATUS[0]}
            else
                "${DOCKER[@]}" run --name "$prog_name" "${DOCKER_ARGS[@]}" -e CLAUDEBOX_CONTAINER_NAME="$prog_name" $CLAUDE_IMAGE "${PASS_ARGS[@]}"
                prog_rc=$?
            fi
            dbg "prog: docker run exited with $prog_rc"
        else
            dbg "prog: container exists, writing args file and starting"
            trap 'rm -f "$CLAUDE_DIR/.${prog_name}-args"' EXIT
            printf '%q ' "${PASS_ARGS[@]}" > "$CLAUDE_DIR/.${prog_name}-args"
            dbg "prog: docker start -a $prog_name"
            if [ -n "$PIPE_MODE" ]; then
                "${DOCKER[@]}" start -a "$prog_name" \
                    | "${DOCKER[@]}" run --rm -i --entrypoint python3 $CLAUDE_IMAGE /home/claude/jsonpipe.py "$PIPE_MODE"
                prog_rc=${PIPESTATUS[0]}
            else
                "${DOCKER[@]}" start -a "$prog_name"
                prog_rc=$?
            fi
            dbg "prog: docker start exited with $prog_rc"
        fi
        exit "$prog_rc"
    fi

    # flag-only args (no prompt): fall through to interactive mode
    [ "$HAS_NO_CONTINUE" = "1" ] && touch "$CLAUDE_DIR/.${container_name}-no-continue"
fi

# signal update via file (env vars don't work with docker start)
UPDATE_FILE="$CLAUDE_DIR/.${container_name}-update"
if [ "$DO_UPDATE" = "1" ]; then
    touch "$UPDATE_FILE"
else
    rm -f "$UPDATE_FILE"
fi

# Interactive — ensure the project VM (+ image) is up first
cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
cb_network_info "$CB_PROJECT_ROOT" "$CB_PROJECT_ID"

# Wait for container to not be running (another session might be using it)
if "${DOCKER[@]}" ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
    echo "⏳ Container '$container_name' is busy. Waiting for it to finish..."
    for i in 1 2 3; do
        sleep $((5 * i))
        if ! "${DOCKER[@]}" ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
            echo "✅ Container is free."
            break
        fi
        echo "   attempt $i/3..."
    done
    if "${DOCKER[@]}" ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        echo "❌ Container is still busy after 3 attempts. Try again later." >&2
        exit 1
    fi
fi

# Interactive — start existing container or create new one
if "${DOCKER[@]}" ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
    echo "🔄 Starting container '$container_name'..."
    "${DOCKER[@]}" start -ai "$container_name"
else
    echo "🔧 Creating container '$container_name'..."
    "${DOCKER[@]}" run -it --name "$container_name" "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE
fi

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

# wire /.claudebox/config.yml into .gitignore, but only inside a real git repo
cb_ensure_gitignore() {
    local root="$1" gi="$1/.gitignore" line="/.claudebox/config.yml"
    [ -d "$root/.git" ] || return 0
    if [ -f "$gi" ]; then
        grep -qxF "$line" "$gi" 2>/dev/null || printf '%s\n' "$line" >> "$gi"
    else
        printf '%s\n' "$line" > "$gi"
    fi
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

# from "name<TAB>status" stdin -> names of running cb-* profiles
cb_running_cb_profiles() { awk -F'\t' '$1 ~ /^cb-/ && $2 == "Running" { print $1 }'; }

# from "name<TAB>status" stdin -> status of $1, or "absent"
cb_status_of() { awk -F'\t' -v p="$1" '$1==p { print $2; f=1 } END { if (!f) print "absent" }'; }

_cb_vm_list_json()    { colima list --json 2>/dev/null; }
cb_vm_status()        { _cb_vm_list_json | cb_parse_vm_lines | cb_status_of "$1"; }
cb_vm_running()       { [ "$(cb_vm_status "$1")" = "Running" ]; }
cb_running_cb_count() { _cb_vm_list_json | cb_parse_vm_lines | cb_running_cb_profiles | grep -c . ; }

# cb_ensure_vm ROOT ID — start the project VM if it isn't running (enforces limits)
cb_ensure_vm() {
    local root="$1" id="$2" profile cpu mem disk count warn hard decision
    profile="$(cb_project_profile "$id")"
    cb_guard_profile "$profile" || return 1
    if cb_vm_running "$profile"; then
        return 0
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
    colima start -p "$profile" \
        --cpu "$(cb_num "$cpu")" --memory "$(cb_num "$mem")" --disk "$(cb_num "$disk")" \
        "${mount_args[@]}"
}

cb_vm_down() {
    local profile; profile="$(cb_project_profile "$1")"
    cb_guard_profile "$profile" || return 1
    if [ "$(cb_vm_status "$profile")" = "absent" ]; then echo "no VM for this project ($profile)"; return 0; fi
    echo "⏹  stopping colima VM '$profile' (keeps disk; 'claudebox' restarts it)..."
    colima stop -p "$profile"
}

cb_vm_destroy() {
    local profile; profile="$(cb_project_profile "$1")"
    cb_guard_profile "$profile" || return 1
    if [ "$(cb_vm_status "$profile")" = "absent" ]; then echo "no VM for this project ($profile)"; return 0; fi
    echo "🗑  deleting colima VM '$profile' and all its containers/volumes..."
    colima delete -f -p "$profile"
}

cb_vm_ls() {
    local lines
    lines="$(_cb_vm_list_json | cb_parse_vm_lines | awk -F'\t' '$1 ~ /^cb-/')"
    if [ -z "$lines" ]; then echo "no claudebox VMs"; return 0; fi
    { printf 'PROFILE\tSTATUS\n'; printf '%s\n' "$lines"; } | column -t -s "$(printf '\t')"
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
esac

# ── resolve the per-project data dir (shared-nothing) unless overridden ───────
# Each project gets its own ~/.claude state under ~/.config/claudebox/projects/<id>.
# Auth is not project state — it still arrives per invocation via env (below) and
# is written into this dir, so there is no shared mutable directory.
if [ -z "$CLAUDE_DIR" ]; then
    CB_PROJECT_ID="$(cb_project_id "$CB_PROJECT_ROOT")"
    CLAUDE_DIR="$(cb_project_data_dir "$CB_PROJECT_ID")"
    dbg "per-project data dir: $CLAUDE_DIR (id=$CB_PROJECT_ID)"
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

# forward env vars to the container
[ -n "$ANTHROPIC_API_KEY" ] && DOCKER_ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && DOCKER_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
[ "$DEBUG" = "true" ] && DOCKER_ARGS+=(-e "DEBUG=true")


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
    docker run -it --rm --name "${container_name}_setup_$$" "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE setup-token
    exit 0
fi

# stop — kill running interactive container for this workspace
if [ "${1:-}" = "stop" ]; then
    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        docker stop "$container_name" >/dev/null 2>&1
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

# cron mode — long-running daemon container, named <base>_cron
_mode_cron="${CLAUDEBOX_MODE_CRON:-${CLAUDE_MODE_CRON:-}}"
_mode_cron_file="${CLAUDEBOX_MODE_CRON_FILE:-${CLAUDE_MODE_CRON_FILE:-}}"
if [ -n "$_mode_cron" ]; then
    cron_name="${container_name}_cron"
    dbg "cron container: $cron_name"

    if [ "${1:-}" = "stop" ]; then
        if docker ps --format '{{.Names}}' | grep -q "^${cron_name}$"; then
            docker stop "$cron_name" >/dev/null 2>&1
            echo "stopped $cron_name"
        else
            echo "cron not running"
        fi
        exit 0
    fi

    if docker ps --format '{{.Names}}' | grep -q "^${cron_name}$"; then
        echo "cron already running ($cron_name)"
        echo "  docker logs -f $cron_name"
        exit 0
    fi

    CRON_ARGS=(
        -e "CLAUDEBOX_MODE_CRON=1"
        -e "CLAUDEBOX_WORKSPACE=$PWD"
        -e "CLAUDEBOX_CONTAINER_NAME=$cron_name"
    )
    [ -n "$_mode_cron_file" ] && CRON_ARGS+=(-e "CLAUDEBOX_MODE_CRON_FILE=$_mode_cron_file")
    [ "$DEBUG" = "true" ]     && CRON_ARGS+=(-e "DEBUG=true")

    if docker ps -a --format '{{.Names}}' | grep -q "^${cron_name}$"; then
        echo "restarting cron container ($cron_name)..."
        docker start "$cron_name"
    else
        echo "starting cron container ($cron_name)..."
        docker run -d --name "$cron_name" "${DOCKER_ARGS[@]}" "${CRON_ARGS[@]}" $CLAUDE_IMAGE
    fi
    echo "  docker logs -f $cron_name"
    exit 0
fi

# passthrough commands — run in throwaway container, bypass entrypoint
case "${1:-}" in
    -v|--version|doctor|auth|mcp)
        docker run --rm --entrypoint claude "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE "$@"
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

        # Programmatic mode — own container, no TTY
        prog_name="${container_name}_prog"
        dbg "prog container: $prog_name"
        prog_rc=0
        if ! docker ps -a --format '{{.Names}}' | grep -q "^${prog_name}$"; then
            dbg "prog: container does not exist, creating with docker run"
            if [ -n "$PIPE_MODE" ]; then
                docker run --name "$prog_name" "${DOCKER_ARGS[@]}" -e CLAUDEBOX_CONTAINER_NAME="$prog_name" $CLAUDE_IMAGE "${PASS_ARGS[@]}" \
                    | docker run --rm -i --entrypoint python3 $CLAUDE_IMAGE /home/claude/jsonpipe.py "$PIPE_MODE"
                prog_rc=${PIPESTATUS[0]}
            else
                docker run --name "$prog_name" "${DOCKER_ARGS[@]}" -e CLAUDEBOX_CONTAINER_NAME="$prog_name" $CLAUDE_IMAGE "${PASS_ARGS[@]}"
                prog_rc=$?
            fi
            dbg "prog: docker run exited with $prog_rc"
        else
            dbg "prog: container exists, writing args file and starting"
            trap 'rm -f "$CLAUDE_DIR/.${prog_name}-args"' EXIT
            printf '%q ' "${PASS_ARGS[@]}" > "$CLAUDE_DIR/.${prog_name}-args"
            dbg "prog: docker start -a $prog_name"
            if [ -n "$PIPE_MODE" ]; then
                docker start -a "$prog_name" \
                    | docker run --rm -i --entrypoint python3 $CLAUDE_IMAGE /home/claude/jsonpipe.py "$PIPE_MODE"
                prog_rc=${PIPESTATUS[0]}
            else
                docker start -a "$prog_name"
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

# Wait for container to not be running (another session might be using it)
if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
    echo "⏳ Container '$container_name' is busy. Waiting for it to finish..."
    for i in 1 2 3; do
        sleep $((5 * i))
        if ! docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
            echo "✅ Container is free."
            break
        fi
        echo "   attempt $i/3..."
    done
    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        echo "❌ Container is still busy after 3 attempts. Try again later." >&2
        exit 1
    fi
fi

# Interactive — start existing container or create new one
if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
    echo "🔄 Starting container '$container_name'..."
    docker start -ai "$container_name"
else
    echo "🔧 Creating container '$container_name'..."
    docker run -it --name "$container_name" "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE
fi

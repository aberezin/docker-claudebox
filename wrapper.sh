#!/usr/bin/env bash

# DRIDOCK_* is the canonical prefix in 3.0+. CLAUDEBOX_* names remain supported as an
# alias for one deprecation cycle (all of 3.x); the alias-setup block just below copies
# every user-supplied CLAUDEBOX_X into DRIDOCK_X so all in-file reads can use the new
# name uniformly. CLAUDE_* names (from upstream v1.x) remain supported one more tier
# back for pre-2.x muscle memory. Removed in 4.0.

# Fork semver — the host wrapper and the built image share an IPC contract (sidecar
# filenames/formats, env conventions, /out, secrets injection). Bump this in the repo
# VERSION file AND here on any contract change; `dridock checkversion` compares this
# host version against the image the project's claudebot runs and warns on drift.
# Kept in sync with the VERSION file (tests/test_cbvm.sh asserts they match). The fork
# runs its OWN semver line. See docs/versioning.md and docs/design/3.0-migration.md.
DRIDOCK_VERSION="3.3.3"

# The name the user actually typed to invoke us. Both `dridock` and legacy
# `claudebox` symlink to this wrapper (install.sh's --bin-name), so help
# text and error messages echo back whichever binary the user has installed.
CB_SELF="${0##*/}"

# Minimum Claude Code CLI the harness expects in the image. NOT the pin (that lives in
# `Dockerfile` ARG CLAUDE_VERSION) — this is the floor `checkversion` warns below, set
# by the newest claude feature dridock forwards a flag for. Currently 2.1.206: the first
# release whose Remote Control surface is complete. Raise it when dridock starts
# depending on a newer claude capability. See #17.
CB_CLAUDE_CLI_FLOOR="2.1.206"

# ── 3.x backward-compat alias setup (#16, standardized in 3.2.1) ─────────────
# For each user-input env var renamed CLAUDEBOX_X → DRIDOCK_X in 3.0, copy the
# CLAUDEBOX_X value into DRIDOCK_X if the user set only the old name. All in-file
# reads below use the new name only. The pair list lives in `env-rename.map` at
# repo root — shared with `entrypoint.sh`'s container-side aliaser, so a new
# rename is a one-line edit. Removed in 4.0. See docs/design/env-var-rename.md.
_dridock_alias() {
    # $1 = new (DRIDOCK_X), $2 = legacy (CLAUDEBOX_X). Copies legacy → new if new is
    # unset AND legacy is set. Uses :- to survive `set -u` if the harness ever adopts
    # it, and stays no-op when both are unset.
    local new="$1" old="$2"
    if [ -z "${!new+x}" ] && [ -n "${!old+x}" ]; then
        eval "$new=\"\${$old}\""
        export "$new"
    fi
}
# Look up the shared map: next to wrapper.sh (dev / source layout), then in the
# installed data dir (per install.sh), then in the container's baked location
# (harmless — this branch only runs on the Mac / dev machine; the container-side
# aliaser reads its own copy). Silent no-op if we can't find one — the wrapper
# still works, just without legacy env-name compat.
_dridock_alias_map_file() {
    local _wrap_dir _try
    _wrap_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
    for _try in \
        "$_wrap_dir/env-rename.map" \
        "${XDG_DATA_HOME:-$HOME/.local/share}/dridock/env-rename.map" \
        "${XDG_DATA_HOME:-$HOME/.local/share}/claudebox/env-rename.map" \
        "/usr/local/share/dridock/env-rename.map"; do
        [ -r "$_try" ] && { printf '%s' "$_try"; return 0; }
    done
    return 1
}
if _dridock_map="$(_dridock_alias_map_file)"; then
    while read -r _new _legacy _rest; do
        case "$_new" in ''|'#'*) continue ;; esac
        [ -n "$_legacy" ] || continue
        _dridock_alias "$_new" "$_legacy"
    done < "$_dridock_map"
    unset _dridock_map _new _legacy _rest
fi
unset -f _dridock_alias_map_file
# CLAUDEBOX_ENV_* and CLAUDEBOX_MOUNT_* prefixes are handled inline where the wrapper
# iterates over them (both prefixes accepted).

# ─────────────────────────────────────────────────────────────────────────────
# Config layer — Phase 1 of docs/design/per-project-vm.md
#
# Pure host-side helpers: per-project identity (.dridock/config.yml, kept
# rehome-safe via a marker file rather than a path hash), the committed sample,
# .gitignore wiring, and the machine-wide config (~/.config/dridock/config.yml)
# with baked-in defaults. No docker/colima here. Source this file with
# DRIDOCK_SOURCE_ONLY=1 to load just these functions (tests/test_cbconfig.sh).
# ─────────────────────────────────────────────────────────────────────────────

cb_config_home() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

# cb_xdg_dir — pick the XDG subdir for our own state. Prefers ~/.config/dridock/
# (3.0+); falls back to ~/.config/claudebox/ for one deprecation cycle if only
# the legacy dir exists. Never resolves to both — callers rely on a single path.
cb_xdg_dir() {
    local xdg new old
    xdg="$(cb_config_home)"
    new="$xdg/dridock"; old="$xdg/claudebox"
    if [ -d "$new" ]; then printf '%s' "$new"
    elif [ -d "$old" ]; then printf '%s' "$old"
    else printf '%s' "$new"; fi
}

# _cb_state_home SUBNAME — same shape as cb_xdg_dir but for a specific sub-tree
# under ~/.config/{dridock,claudebox}/<SUBNAME>. Prefers the dridock/ path (3.0+),
# transparently falls back to the legacy claudebox/ path if only that exists (so
# a user who hasn't run `dridock migrate` doesn't lose access to their consults /
# framework-bug reports / cdp state), otherwise returns the dridock/ path as
# canonical for a fresh mkdir. Callers still need to `mkdir -p` before writing.
# `dridock migrate` (cb_migrate_state_dirs) relocates each legacy subdir to the
# dridock/ one so this fallback becomes a no-op post-migrate; kept for one
# deprecation cycle (removed in 4.0 with the legacy root).
#
# #32 — persistent split-brain warning. When BOTH roots have the same subdir,
# reads unconditionally prefer dridock/, silently orphaning legacy content.
# Warn on every invocation (deduped per-name via a shell variable) so the user
# can't miss the state until they clean it up.
_cb_state_home() {
    local base new old
    base="$(cb_config_home)"
    new="$base/dridock/$1"; old="$base/claudebox/$1"
    # Split-brain: warn once per name per shell (var name is deterministic; safe under set -u via ${…-}).
    if [ -d "$new" ] && [ -d "$old" ]; then
        local _warn_var="_CB_SPLIT_WARNED_${1//-/_}"
        if [ -z "${!_warn_var-}" ]; then
            echo "⚠ state dir $1: SPLIT — ~/.config/dridock/$1 AND ~/.config/claudebox/$1 both exist. Reads prefer dridock/; legacy content is orphaned. 'dridock migrate' will refuse; merge or remove one root by hand." >&2
            eval "$_warn_var=1"
        fi
        printf '%s' "$new"
        return 0
    fi
    if [ -d "$new" ]; then printf '%s' "$new"
    elif [ -d "$old" ]; then printf '%s' "$old"
    else printf '%s' "$new"; fi
}

cb_machine_config_path() {
    local base; base="$(cb_xdg_dir)"
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
        vm.disk|vm.default_disk)     printf '100GiB' ;;
        vm.autostop)                 printf 'false' ;;
        vm.warn_max)                 printf '3' ;;
        vm.hard_max)                 printf '5' ;;
        data_root)                   printf '%s/projects' "$(cb_xdg_dir)" ;;
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

# true if a path is inside a `.dridock` or `.claudebox` metadata dir — i.e. an
# accidental workspace. Both prefixes accepted for one deprecation cycle.
cb_in_dotclaudebox() {
    case "${1:-$PWD}" in
        */.dridock|*/.dridock/*|*/.claudebox|*/.claudebox/*) return 0 ;;
        *) return 1 ;;
    esac
}

# Guard against launching the claudebot with `.claudebox` as its workspace (running
# `claudebox` from inside that metadata dir). The project VM is still correct (root is the
# git toplevel), but the mounted workspace + container would be keyed to `.claudebox` — a
# stray, almost-never-intended setup. Prompt if interactive; else abort (override:
# DRIDOCK_ALLOW_SUBDIR=1). $1 = resolved project root (for the suggested cd).
cb_guard_workspace() {
    local root="$1" ans target
    cb_in_dotclaudebox "$PWD" || return 0
    # Strip either .dridock or .claudebox suffix — whichever the path is in.
    case "$PWD" in
        */.dridock|*/.dridock/*)     target="${PWD%%/.dridock*}"   ; dotname=".dridock" ;;
        */.claudebox|*/.claudebox/*) target="${PWD%%/.claudebox*}" ; dotname=".claudebox" ;;
        *)                           target=""                     ; dotname="" ;;
    esac
    [ -n "$target" ] || target="$root"
    {
        echo "⚠️  You're inside a '${dotname:-.dridock}' directory:"
        echo "      $PWD"
        echo "   claudebot would mount THIS dir as its workspace (not your project) and create a"
        echo "   separate stray container for it. You almost certainly want the project root:"
        echo "      cd $(printf '%q' "$target") && claudebox"
    } >&2
    case "${DRIDOCK_ALLOW_SUBDIR:-}" in 1|true|yes|on) echo "   (DRIDOCK_ALLOW_SUBDIR set — proceeding)" >&2; return 0 ;; esac
    if [ -t 0 ]; then
        printf "   Continue with this dir anyway? [y/N] " >&2
        read -r ans
        case "$ans" in y|Y|yes|YES) return 0 ;; esac
        echo "   aborted — cd to the project root and re-run." >&2; return 1
    fi
    echo "   aborting (non-interactive) — set DRIDOCK_ALLOW_SUBDIR=1 to override." >&2
    return 1
}

# Guard accidental "spawn a fresh project in some random dir". Silent creation of
# .dridock/config.yml (+ a per-project Colima VM, ~30-60s to boot, resources reserved)
# is easy to trigger by mistake — cd'ing into a scratch dir, wrong-terminal `dridock`,
# etc. Prompt if interactive; else abort (override: DRIDOCK_ALLOW_NEW=1). Skipped by
# the utility-command allowlist below (setup-token/mcp/stop/... don't create anything)
# and by `bootstrap` (it creates the config itself, then re-execs). $1 = project root.
cb_guard_new_project() {
    local root="$1" ans cfg
    cfg="$(cb_project_config_path "$root")"
    [ ! -f "$cfg" ] || return 0
    {
        echo "⚠️  No dridock project here — no .dridock/config.yml (or legacy .claudebox/config.yml) at:"
        echo "      $root"
        echo "   Starting dridock will create a new project (its own Colima VM,"
        echo "   ~30-60s to boot, reserves CPU/RAM/disk). For a proper new project"
        echo "   with a mission brief, prefer:  dridock bootstrap \"<intent>\""
    } >&2
    case "${DRIDOCK_ALLOW_NEW:-}" in 1|true|yes|on) echo "   (DRIDOCK_ALLOW_NEW set — proceeding)" >&2; return 0 ;; esac
    if [ -t 0 ]; then
        printf "   Create a new dridock project at this path? [y/N] " >&2
        read -r ans
        case "$ans" in y|Y|yes|YES) return 0 ;; esac
        echo "   aborted — cd to an existing project, or use 'dridock bootstrap'." >&2
        return 1
    fi
    echo "   aborting (non-interactive) — use 'dridock bootstrap', or set DRIDOCK_ALLOW_NEW=1 to override." >&2
    return 1
}

# true if $1 is a claudebox harness fork workspace (fingerprint: wrapper.sh at root with
# CLAUDEBOX_VERSION= line), OR DRIDOCK_HARNESS_DEV=1 forces the mode. Used to gate
# framework-dev behaviors: skip the drift warning, gate `claudebox harness <verb>`
# commands, mirror the entrypoint's fw-dev surfacing. DRIDOCK_FRAMEWORK_DEV kept as
# a backward-compat alias (renamed 2.22.0 to match the harness naming convention).
cb_is_framework_dev() {
    case "${DRIDOCK_HARNESS_DEV:-${DRIDOCK_FRAMEWORK_DEV:-}}" in 1|true|yes|on) return 0 ;; esac
    [ -f "$1/wrapper.sh" ] && grep -Eq '^(DRIDOCK_VERSION|CLAUDEBOX_VERSION)=' "$1/wrapper.sh" 2>/dev/null
}

# Warn (never block) when the shared cb-infra image is BEHIND the wrapper's version. On
# a normal `claudebox` invocation, an out-of-date cb-infra silently ships a stale image
# to any project VM that reseeds from it — the drift is invisible until a fresh project
# pulls the old bits. `checkversion` catches this if run explicitly, but this surfaces it
# on every boot path so drift doesn't accumulate. Auto-skipped for the framework-dev
# workspace (the person iterating there IS the one causing drift and doesn't need to be
# told). Also skippable via DRIDOCK_NO_DRIFT_WARN=1 for scripted/CI contexts. Fast:
# cb_image_status returns "unavailable" without booting cb-infra if it's down.
cb_check_infra_drift() {
    local root="$1" civ cver
    case "${DRIDOCK_NO_DRIFT_WARN:-}" in 1|true|yes|on) return 0 ;; esac
    cb_is_framework_dev "$root" && return 0
    civ="$(cb_image_status "$(cb_infra_context)" 2>/dev/null)"
    cver="$(cb_real_ver "$civ")"
    [ -z "$cver" ] && return 0                                   # cb-infra down / unstamped — silent
    [ "$cver" = "$DRIDOCK_VERSION" ] && return 0                # in sync — silent
    case "$(cb_semver_cmp "$DRIDOCK_VERSION" "$cver")" in
        gt)
            case "$(cb_semver_severity "$DRIDOCK_VERSION" "$cver")" in
                major) echo "🔴 cb-infra image ($cver) is MAJOR behind wrapper ($DRIDOCK_VERSION) — rebuild REQUIRED on the Mac:  make build" >&2 ;;
                minor) echo "🟠 cb-infra image ($cver) is MINOR behind wrapper ($DRIDOCK_VERSION) — SHOULD rebuild on the Mac:  make build" >&2 ;;
                patch) echo "🟡 cb-infra image ($cver) is PATCH behind wrapper ($DRIDOCK_VERSION) — rebuild optional:  make build" >&2 ;;
            esac
            echo "   (fresh project VMs will reseed from this cb-infra; set DRIDOCK_NO_DRIFT_WARN=1 to silence)" >&2 ;;
        lt) echo "⚠  cb-infra image ($cver) is AHEAD of wrapper ($DRIDOCK_VERSION) — update the wrapper:  ./install.sh" >&2 ;;
    esac
    return 0
}

# ── claudebox harness <verb> ─ framework-dev-only commands ───────────────────
# The `harness` namespace groups verbs meaningful only when developing the claudebox
# harness itself (this fork). They're gated by cb_is_framework_dev (fingerprint on
# $CB_PROJECT_ROOT) so running them in gammaray etc. errors clearly instead of doing
# something surprising. Marked "framework-dev:" in --help so non-dev users see the tag
# and skip past it (same pattern as host-agent's TRUSTED tag).

# cb_harness_sync — rebuild cb-infra's claudebox:latest from the current wrapper
# checkout. Thin wrapper around `make build`. On the Mac (colima backend) this is what
# `make build` already does; the value of a wrapper verb is (a) discoverability from
# `claudebox --help`, (b) an explicit in-container guard — running it from inside a
# framework-dev claudebot would build on the CONTAINER's own VM daemon (docker backend),
# NOT cb-infra, so we refuse and print the exact Mac command to run instead, and
# (c) `--repair`: on the specific BuildKit snapshot-corruption failure that surfaces
# as `failed to prepare extraction snapshot ... parent snapshot ... does not exist`,
# auto-prune cb-infra's build cache and retry once. That failure is rare-but-real
# (interrupted build, prune racing with build, upgrade-across-versions) and the manual
# recovery is always `docker builder prune -af` followed by a retry — this wraps it.
cb_harness_sync() {
    local root="$CB_PROJECT_ROOT" repair=0 build_log rc pattern
    while [ $# -gt 0 ]; do case "$1" in
        --repair)   repair=1 ;;
        -h|--help)  echo "usage: dridock harness sync [--repair]  (--repair: on BuildKit snapshot corruption, auto-prune cb-infra cache and retry)" >&2; return 0 ;;
        *)          echo "dridock harness sync: unknown arg '$1'" >&2; return 1 ;;
    esac; shift; done
    if ! cb_is_framework_dev "$root"; then
        echo "❌ dridock harness sync: $root is not a dridock harness fork (no wrapper.sh with DRIDOCK_VERSION= or legacy CLAUDEBOX_VERSION= at its root)." >&2
        echo "   This command rebuilds the cb-infra image from a harness checkout; it's meaningful only when developing the harness itself." >&2
        return 1
    fi
    if [ -f /.dockerenv ]; then
        echo "❌ dridock harness sync: must run on the Mac (colima backend) to update cb-infra." >&2
        echo "   From inside a container the docker backend would build on this VM's own daemon, not cb-infra." >&2
        echo "   On your Mac:  cd $(printf '%q' "$root") && dridock harness sync   (equivalent: make build)" >&2
        return 1
    fi
    echo "🔨 dridock harness sync: rebuilding cb-infra image from $root (this is 'make build' on the colima backend)…"
    if [ "$repair" = 0 ]; then
        ( cd "$root" && make build )
        return $?
    fi
    # --repair: tee build output (stdout+stderr) so user sees it live AND we can grep
    # for the corruption pattern on failure. `set -o pipefail` isn't safe to enable
    # here (the wrapper's own shell), so use PIPESTATUS to preserve make's exit code.
    build_log="$(mktemp -t cb-harness-sync.XXXXXX)"
    trap 'rm -f "$build_log"' RETURN
    ( cd "$root" && make build ) 2>&1 | tee "$build_log"
    rc=${PIPESTATUS[0]}
    [ "$rc" = 0 ] && return 0
    # Match BuildKit snapshotter corruption specifically — do NOT prune on unrelated
    # failures (Dockerfile syntax error, apt-get network timeout, disk full, etc.).
    pattern='failed to prepare extraction snapshot|parent snapshot .* does not exist'
    if ! grep -qE "$pattern" "$build_log"; then
        echo "" >&2
        echo "❌ build failed, but not with a recognized BuildKit corruption pattern — --repair can't help here." >&2
        echo "   Fix the underlying error and retry with 'dridock harness sync' (no --repair)." >&2
        return "$rc"
    fi
    echo "" >&2
    echo "🛠  detected BuildKit snapshotter corruption — pruning cb-infra build cache and retrying…" >&2
    docker --context "$(cb_infra_context)" builder prune -af
    echo "" >&2
    echo "🔨 retrying build with clean cache (this will be a cold start — expect ~10-20 min)…" >&2
    ( cd "$root" && make build )
    rc=$?
    if [ "$rc" = 0 ]; then
        echo "" >&2
        echo "✅ recovered — cb-infra rebuilt from a clean cache." >&2
        return 0
    fi
    echo "" >&2
    echo "❌ still failing after a nuclear cache prune. Next thing to try is a colima restart:" >&2
    echo "     colima stop -p cb-infra && colima start -p cb-infra" >&2
    echo "     dridock harness sync   (or: make build)" >&2
    return "$rc"
}

# cb_project_dot ROOT — the metadata dir path for this project. Prefer .dridock
# (3.0+); fall back to legacy .claudebox for one deprecation cycle if only that
# exists. Neither exists → default to .dridock (used by bootstrap / first-run
# init). This is the single source of truth for "which dir do I read/write to?"
# — every helper that touches config.yml, secrets.env, BRIEF.md, config.sample.yml
# routes through here. Migration: `dridock migrate` (Phase 4b) renames on disk.
cb_project_dot() {
    local root="$1"
    if [ -d "$root/.dridock" ]; then
        printf '%s/.dridock' "$root"
    elif [ -d "$root/.claudebox" ]; then
        printf '%s/.claudebox' "$root"
    else
        printf '%s/.dridock' "$root"
    fi
}
# cb_project_dot_basename ROOT — just the basename (.dridock or .claudebox), for
# error messages and gitignore lines that don't want the full path.
cb_project_dot_basename() { basename "$(cb_project_dot "$1")"; }

cb_project_config_path() { printf '%s/config.yml' "$(cb_project_dot "$1")"; }

# wire the machine-local .claudebox files (config + secrets) into .gitignore, but
# only inside a real git repo — NEITHER may ever be committed (secrets.env holds
# credentials; config.yml is host-local VM sizing/identity).
cb_ensure_gitignore() {
    local root="$1" gi="$1/.gitignore" line
    [ -d "$root/.git" ] || return 0
    # Add both .dridock (canonical 3.0+) and .claudebox (legacy) entries so a project
    # mid-migration doesn't accidentally commit either the new or old config/secrets.
    for line in /.dridock/config.yml /.dridock/secrets.env /.claudebox/config.yml /.claudebox/secrets.env; do
        if [ -f "$gi" ]; then
            grep -qxF "$line" "$gi" 2>/dev/null || printf '%s\n' "$line" >> "$gi"
        else
            printf '%s\n' "$line" > "$gi"
        fi
    done
}

# ── project secrets (machine-local, gitignored, chmod 600) ───────────────────
# Source of truth is .dridock/secrets.env (KEY=VALUE lines; legacy .claudebox/secrets.env is
# still read for one deprecation cycle). It is injected into
# the container as env on every run and — crucially — persisted to a per-container
# sidecar the entrypoint re-reads on each start, so secrets survive `docker start`
# (which, unlike `docker run`, can't inject new env). A GH_TOKEN line = a claudebot
# that boots authenticated to GitHub with no interactive `gh auth login`.
cb_secrets_path() { printf '%s/secrets.env' "$(cb_project_dot "$1")"; }  # $1=root; gitignored

# cb_secrets_put ROOT KEY VALUE — set/replace KEY in .dridock/secrets.env (create
# with a header + chmod 600 if absent). Never echoes the value. Used by bootstrap
# --seed-secret / --secrets-file (and legacy --gh-token); secrets are NEVER accepted on the command line.
cb_secrets_put() {
    local root="$1" key="$2" val="$3" sf tmp dotname
    sf="$(cb_secrets_path "$root")"; mkdir -p "$(dirname "$sf")"
    dotname="$(basename "$(dirname "$sf")")"
    if [ ! -f "$sf" ]; then
        printf '%s\n%s\n' \
            "# ${dotname}/secrets.env — machine-local, gitignored, chmod 600. KEY=VALUE per line." \
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
    local dot; dot="$(cb_project_dot "$1")"; local dotname; dotname="$(basename "$dot")"
    cat > "$dot/config.sample.yml" <<CBSAMPLE
# ${dotname}/config.sample.yml — schema reference (committed).
# The wrapper generates the real, gitignored ${dotname}/config.yml on first run.
id: auto                  # stable project identity; generated once, never change
vm:
  cpu: 4
  memory: 8GiB
  disk: 100GiB
  autostop: false         # stop the VM when the harness container exits
network:
  hostname:               # optional: set e.g. "myproj" for a friendly http://myproj:<port> (/etc/hosts alias -> VM IP; run 'dridock net'); blank = raw IP
# features: []            # opt-in tool bundles, e.g. [typescript, python] — list them: 'dridock features'
CBSAMPLE
}

# cb_init_project_config ROOT — ensure config + sample + gitignore; print the id.
cb_init_project_config() {
    local root="$1" cfg id cpu mem disk dot dotname
    dot="$(cb_project_dot "$root")"; dotname="$(basename "$dot")"
    mkdir -p "$dot"
    cfg="$(cb_project_config_path "$root")"
    [ -f "$cfg" ] && id="$(_cb_yaml_get "$cfg" id)"
    if [ -z "${id:-}" ] || [ "${id:-}" = "auto" ]; then
        id="$(cb_gen_id)"
        cpu="$(cb_machine_get vm.default_cpu)"
        mem="$(cb_machine_get vm.default_memory)"
        disk="$(cb_machine_get vm.default_disk)"
        cat > "$cfg" <<CBCONF
# ${dotname}/config.yml — generated by the wrapper; edit to taste. Gitignored.
id: $id
vm:
  cpu: $cpu
  memory: $mem
  disk: $disk
  autostop: false         # stop the VM when the harness container exits
network:
  hostname:               # optional: set e.g. "myproj" for a friendly http://myproj:<port> (/etc/hosts alias -> VM IP; run 'dridock net'); blank = raw IP
# features: []            # opt-in tool bundles, e.g. [typescript, python] — list them: 'dridock features'
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

# compare dotted versions X.Y.Z -> prints gt|lt|eq for $1 vs $2. Non-numeric/suffix
# parts (0.1.0-rc1) are reduced to their leading digits; missing fields count as 0.
cb_semver_cmp() {
    local i x y; local -a A B
    IFS=. read -r -a A <<<"$1"; IFS=. read -r -a B <<<"$2"
    for i in 0 1 2; do
        x="${A[$i]:-0}"; y="${B[$i]:-0}"       # :- guards unset fields under set -u
        x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"   # keep leading digits only (0-rc1 -> 0)
        x=$((10#${x:-0})); y=$((10#${y:-0}))
        [ "$x" -gt "$y" ] && { printf gt; return; }
        [ "$x" -lt "$y" ] && { printf lt; return; }
    done
    printf eq
}

# the level at which two dotted versions FIRST differ: major|minor|patch|none. Maps to
# rebuild urgency: major = breaking IPC contract (MUST), minor = additive (SHOULD),
# patch = fixes only (OPTIONAL). See docs/versioning.md "when to bump".
cb_semver_severity() {
    local i x y; local -a A B N=(major minor patch)
    IFS=. read -r -a A <<<"$1"; IFS=. read -r -a B <<<"$2"
    for i in 0 1 2; do
        x="${A[$i]:-0}"; y="${B[$i]:-0}"; x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
        [ "$((10#${x:-0}))" != "$((10#${y:-0}))" ] && { printf '%s' "${N[$i]}"; return; }
    done
    printf none
}

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
# dridock VM instead of `default`.
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
    local ctx="$1" have want
    if docker --context "$ctx" image inspect "$CLAUDE_IMAGE" >/dev/null 2>&1; then
        # Image present. Auto-reseed if cb-infra is ALREADY running and holds a
        # newer-versioned image (e.g. right after `make build`), so a rebuild reaches
        # existing project VMs without a manual `rmi`. Only when cb-infra is up — never
        # boot it just to check (keeps normal startup cheap when nothing changed).
        if cb_vm_running "$CB_INFRA_PROFILE"; then
            have="$(cb_image_version "$ctx")"; want="$(cb_image_version "$(cb_infra_context)")"
            if [ -n "$want" ] && [ "$want" != "$have" ] && { [ -z "$have" ] || [ "$(cb_semver_cmp "$want" "$have")" = gt ]; }; then
                echo "📦 project image (${have:-unstamped}) is behind cb-infra ($want) — reseeding..." >&2
                docker --context "$(cb_infra_context)" save "$CLAUDE_IMAGE" | docker --context "$ctx" load >/dev/null
            fi
        fi
        return 0
    fi
    cb_require_image_source || return 1
    echo "📦 seeding $CLAUDE_IMAGE into project VM (one-time save|load)..." >&2
    docker --context "$(cb_infra_context)" save "$CLAUDE_IMAGE" | docker --context "$ctx" load >/dev/null
}

# Recreate the project's container if it was created from a now-stale image (e.g. after
# cb_ensure_image reseeded a rebuild) — a plain `docker start` otherwise keeps running
# the OLD image. Compares the container's image id to the current tag's id and removes
# the container so the run path recreates it. Session state survives (host ~/.claude
# mount); container-fs scratch (runtime apt/npm installs) does not. No-op if the
# container is absent or already current. $1=ctx  $2=container name.
cb_refresh_container() {
    local ctx="$1" name="$2" cimg iimg
    cimg="$(docker --context "$ctx" inspect --format '{{.Image}}' "$name" 2>/dev/null)" || return 0
    [ -n "$cimg" ] || return 0
    iimg="$(docker --context "$ctx" image inspect --format '{{.Id}}' "$CLAUDE_IMAGE" 2>/dev/null)"
    [ -n "$iimg" ] || return 0
    if [ "$cimg" != "$iimg" ]; then
        echo "🔁 harness image changed — recreating '$name' on the new image (session preserved; runtime-installed tools are not)." >&2
        docker --context "$ctx" rm -f "$name" >/dev/null 2>&1 || true
    fi
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
            deny) echo "❌ $count dridock VMs already running (hard_max=$hard). Free one with 'dridock down' or 'dridock destroy'." >&2; return 1 ;;
            warn) echo "⚠️  $count dridock VMs running (warn_max=$warn); starting another." >&2 ;;
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
    # Refresh the VM-IP env now that the VM is guaranteed up — must happen HERE, not
    # earlier in the wrapper: on a first-run cold boot the plain lookup used to race
    # `colima start --network-address` (col0 reachability lags by seconds), leaving
    # DRIDOCK_VM_IP unset in the fresh container until the next invocation. See
    # cb_inject_vm_env / cb_wait_reachable.
    cb_inject_vm_env "$id" "$root"
}

cb_vm_down() {
    local profile; profile="$(cb_project_profile "$1")"
    cb_guard_profile "$profile" || return 1
    if [ "$(cb_vm_status "$profile")" = "absent" ]; then echo "no VM for this project ($profile)"; return 0; fi
    echo "⏹  stopping colima VM '$profile' (keeps disk; 'dridock' restarts it)..."
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

# cb_purge_data ID — delete this project's HOST data dir (Claude session history +
# --continue state, auth/secrets sidecars, settings, plugins, init.d). This is the
# per-project shared-nothing ~/.claude; a plain `destroy` leaves it (session survives),
# `destroy --purge` calls this for a truly clean slate. Guarded: only ever removes a
# real <data_root>/<id> dir, and refuses when a DRIDOCK_DATA_DIR override is in effect
# (that path is arbitrary/user-owned — the human removes it).
cb_purge_data() {
    local id="$1" root proj
    case "$id" in ''|*[!0-9a-f]*|*/*) echo "refusing to purge — unexpected project id: '$id'" >&2; return 1 ;; esac
    if [ -n "${DRIDOCK_DATA_DIR:-${CLAUDE_DATA_DIR:-}}" ]; then
        echo "⚠ DRIDOCK_DATA_DIR override is set — not auto-deleting it; remove it yourself: ${DRIDOCK_DATA_DIR:-$CLAUDE_DATA_DIR}" >&2
        return 0
    fi
    root="$(cb_data_root)"; proj="$root/$id"
    case "$proj" in "$root"/?*) : ;; *) echo "refusing to purge unexpected path: $proj" >&2; return 1 ;; esac
    if [ -d "$proj" ]; then
        rm -rf "$proj" && echo "🗑  purged this project's session/data dir ($proj) — history & sidecars gone"
    else
        echo "no per-project data dir to purge ($proj)"
    fi
}

cb_vm_ls() {
    local rows proj infra
    rows="$(_cb_vm_list_json | cb_parse_vm_lines)"
    proj="$(printf '%s\n' "$rows"  | awk -F'\t' '$1 ~ /^cb-/ && $1 != "cb-infra"')"
    infra="$(printf '%s\n' "$rows" | awk -F'\t' '$1 == "cb-infra" { print $2 }')"
    if [ -z "$proj" ]; then
        echo "no dridock project VMs"
    else
        { printf 'PROFILE\tSTATUS\n'; printf '%s\n' "$proj"; } | column -t -s "$(printf '\t')"
    fi
    [ -n "$infra" ] && printf 'infra (cb-infra): %s\n' "$infra"
    return 0
}

# bytes -> human (portable; avoids a numfmt dependency)
cb_h() { awk -v b="${1:-0}" 'BEGIN{split("B K M G T P",u," ");i=1;while(b>=1024&&i<6){b/=1024;i++};printf((b==int(b))?"%d%s":"%.1f%s"),b,u[i]}'; }
# actual host KB used by a path (0 if missing) — measures the sparse file's real footprint
cb_du_k() { if [ -e "$1" ]; then du -sk "$1" 2>/dev/null | awk '{print $1; exit}'; else echo 0; fi; }

# `claudebox vm usage` — how much Mac disk each dridock VM (and each orphaned disk)
# actually occupies. VM disks are sparse: the "MAX" cap rarely reflects real usage, and
# `colima delete` leaks disks, so this surfaces both live footprint and reclaimable junk.
cb_vm_usage() {
    local lh statuses live="" orph="" name max inuse profile status tag act dk ik
    local proj_k=0 infra_k=0 def_k=0 orph_k=0
    lh="$(cb_lima_home)" || { echo "colima LIMA_HOME not found (is colima installed?)" >&2; return 1; }
    command -v limactl >/dev/null 2>&1 || { echo "limactl not found — cannot read disk usage" >&2; return 1; }
    statuses="$(_cb_vm_list_json | cb_parse_vm_lines)"
    # A disk is orphaned ONLY if no colima profile owns it — NOT merely if it's not in use
    # by a *running* VM (limactl's IN-USE-BY is blank for stopped VMs, so keying on it would
    # misflag every stopped VM's disk, incl. cb-infra, as junk to delete). Cross-reference the
    # disk name against the known colima profiles (which include Stopped ones).
    local known; known="$(printf '%s\n' "$statuses" | awk -F'\t' 'NF{print $1}')"
    while IFS="$(printf '\t')" read -r name max inuse; do
        [ -n "$name" ] || continue
        profile="${name#colima-}"; [ "$name" = colima ] && profile="default"
        # measure disk + instance dir by NAME (not IN-USE-BY) so stopped VMs still count
        dk="$(cb_du_k "$lh/_disks/$name")"; ik="$(cb_du_k "$lh/$name")"
        act=$((dk + ik))
        if ! printf '%s\n' "$known" | grep -qxF "$profile"; then
            orph="$orph$name\t$(cb_h $((act * 1024)))\t$max\n"; orph_k=$((orph_k + act))
        else
            status="$(printf '%s\n' "$statuses" | awk -F'\t' -v p="$profile" '$1==p{print $2}')"
            [ -n "$status" ] || status="?"
            tag=""
            case "$name" in
                colima)          def_k=$((def_k + act)); tag=" (human)" ;;
                colima-cb-infra) infra_k=$((infra_k + act)) ;;
                colima-cb-*)     proj_k=$((proj_k + act)) ;;
            esac
            live="$live$profile$tag\t$status\t$(cb_h $((act * 1024)))\t$max\n"
        fi
    done < <(LIMA_HOME="$lh" limactl disk ls 2>/dev/null | awk 'NR>1{iu=(NF>=5?$5:""); print $1"\t"$2"\t"iu}')

    echo "dridock VM disk usage (actual on the Mac / provisioned max):"
    { printf 'PROFILE\tSTATUS\tON-DISK\tMAX\n'; printf '%b' "$live"; } | column -t -s "$(printf '\t')"
    if [ -n "$orph" ]; then
        echo ""
        echo "orphaned disks — no VM owns these (reclaim with 'dridock vm gc'):"
        { printf 'DISK\tON-DISK\tMAX\n'; printf '%b' "$orph"; } | column -t -s "$(printf '\t')"
    fi
    echo ""
    printf 'totals — projects: %s   cb-infra: %s   default(human): %s   orphaned: %s\n' \
        "$(cb_h $((proj_k * 1024)))" "$(cb_h $((infra_k * 1024)))" "$(cb_h $((def_k * 1024)))" "$(cb_h $((orph_k * 1024)))"
    return 0
}

# `claudebox vm gc` — reclaim Mac disk: delete orphaned lima disks colima left behind,
# then fstrim every running dridock VM (cb-* incl. cb-infra) so freed blocks return to
# macOS. The human's `default` VM is deliberately left untouched.
cb_vm_gc() {
    local lh before after freed orphans n p trimmed=0 _pr
    lh="$(cb_lima_home)" || { echo "colima LIMA_HOME not found (is colima installed?)" >&2; return 1; }
    command -v limactl >/dev/null 2>&1 || { echo "limactl not found — cannot gc" >&2; return 1; }
    before="$(cb_du_k "$lh")"

    echo "🧹 pruning orphaned lima disks (no owning colima profile)…"
    # SAFETY: a disk is orphaned only if NO colima profile owns it. Do NOT key on limactl's
    # IN-USE-BY column (NF<5) — that is blank for every STOPPED VM, so it would delete a valid
    # stopped VM's disk (e.g. the cb-infra image store, or any idle project VM). Cross-reference
    # disk names against the known colima profiles (which include Stopped ones).
    local known; known="$(_cb_vm_list_json | cb_parse_vm_lines | awk -F'\t' 'NF{print $1}')"
    orphans=""
    while IFS= read -r _dn; do
        [ -n "$_dn" ] || continue
        local _dp; _dp="${_dn#colima-}"; [ "$_dn" = colima ] && _dp="default"
        printf '%s\n' "$known" | grep -qxF "$_dp" || orphans="${orphans:+$orphans }$_dn"
    done < <(LIMA_HOME="$lh" limactl disk ls 2>/dev/null | awk 'NR>1{print $1}')
    if [ -n "$orphans" ]; then
        printf '   - %s\n' $orphans
        # shellcheck disable=SC2086
        if LIMA_HOME="$lh" limactl disk delete $orphans >/dev/null 2>&1; then
            n="$(printf '%s\n' "$orphans" | grep -c .)"; echo "   ✓ deleted $n orphaned disk(s)"
        else echo "   ⚠ some orphaned disks could not be deleted" >&2; fi
    else
        echo "   (none)"
    fi

    echo "🖼  pruning dangling images + BuildKit build cache in running dridock VMs…"
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        # dangling images AND build cache — build cache is the real accumulator on
        # image-iterating projects, and `image prune` never touches it (see
        # docs/design/disk-management.md).
        _pi="$(docker --context "colima-$p" image prune -f 2>/dev/null | grep -i 'reclaimed' | sed 's/.*: //')"
        _pb="$(docker --context "colima-$p" builder prune -f 2>/dev/null | grep -i 'reclaimed' | sed 's/.*: //')"
        printf '   - %-14s images %s · build cache %s\n' "$p" "${_pi:-0B}" "${_pb:-0B}"
    done < <(_cb_vm_list_json | cb_parse_vm_lines | awk -F'\t' '$1 ~ /^cb-/ && $2 == "Running" {print $1}')

    echo "🧻 fstrim on running dridock VMs (return freed blocks to macOS)…"
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        printf '   - %s … ' "$p"
        # </dev/null: `colima ssh` reads stdin and would otherwise swallow the rest of
        # this loop's input (process substitution), stopping after the first VM.
        if colima ssh -p "$p" -- sudo fstrim -av </dev/null >/dev/null 2>&1; then echo "ok"; trimmed=$((trimmed + 1))
        else echo "skipped (unreachable?)"; fi
    done < <(_cb_vm_list_json | cb_parse_vm_lines | awk -F'\t' '$1 ~ /^cb-/ && $2 == "Running" {print $1}')
    [ "$trimmed" -eq 0 ] && echo "   (no running dridock VMs)"

    after="$(cb_du_k "$lh")"
    freed=$(( (before - after) * 1024 )); [ "$freed" -lt 0 ] && freed=0
    echo ""
    echo "✅ vm gc done — reclaimed ~$(cb_h "$freed"); colima now uses $(cb_h $((after * 1024)))."
    echo "   (default/human VM left untouched — trim it yourself: colima ssh -p default -- sudo fstrim -av)"
    return 0
}

# version stamped into $CLAUDE_IMAGE in a docker context ($1). Distinguishes three
# states: the semver, "unstamped" (image present but built pre-versioning = empty
# label), or "unavailable" (image absent / VM or context down). image inspect returns
# "" for a missing label but nonzero for a missing image, so the two don't conflate.
# The Claude Code CLI version actually installed in the image (#17). Deliberately a
# runtime probe rather than a build-time LABEL: the pin in `Dockerfile` ARG
# CLAUDE_VERSION is what we *asked* for, this is what the image *has* — and it's the
# latter that decides whether a feature-gating flag like `--remote-control` is real or
# gets silently eaten. Costs one throwaway container, so it's only used by the explicit
# `checkversion` verb, never on the hot path. $1 = docker context.
cb_image_claude_version() {
    local out
    out="$(docker --context "$1" run --rm --entrypoint claude "$CLAUDE_IMAGE" --version 2>/dev/null | head -1)"
    case "$out" in ''|*[![:print:]]*) printf 'unavailable' ;; *) printf '%s' "${out%% (Claude Code)}" ;; esac
}

# Build a 0600 temp `--env-file` from a sidecar, keeping only KEY=VALUE lines that have a
# value. For the entrypoint-BYPASSING passthroughs (`--entrypoint claude`), which never get
# to read the sidecars themselves. Prints the temp path, or nothing if there's nothing to
# pass — caller is responsible for rm'ing it. Never `-e`: a value on the docker command
# line is world-readable via `ps` for as long as the process lives. $1 = sidecar path.
cb_mktemp_envfile() {
    local src="$1" tmp name value wrote=0
    [ -f "$src" ] || return 0
    tmp="$(mktemp "${TMPDIR:-/tmp}/dridock-env-XXXXXX")" || return 0
    chmod 600 "$tmp"
    while IFS='=' read -r name value; do
        case "$name" in ''|\#*) continue ;; esac
        [ -n "$value" ] || continue      # bare KEY= would become set-but-empty; skip it
        printf '%s=%s\n' "$name" "$value" >> "$tmp"; wrote=1
    done < "$src"
    if [ "$wrote" = 0 ]; then rm -f "$tmp"; return 0; fi
    printf '%s' "$tmp"
}

cb_image_status() {
    local out
    # Read org.dridock.version (3.0+); fall back to org.claudebox.version (2.x) so
    # `checkversion` on a 3.0 wrapper against a 2.x image shows the version instead of
    # "unstamped". Backward-compat for one deprecation cycle. See 3.0-migration.md.
    if ! out="$(docker --context "$1" image inspect "$CLAUDE_IMAGE" \
                 --format '{{ or (index .Config.Labels "org.dridock.version") (index .Config.Labels "org.claudebox.version") }}' 2>/dev/null)"; then
        printf 'unavailable'; return
    fi
    case "$out" in ''|'<no value>') printf 'unstamped' ;; *) printf '%s' "$out" ;; esac
}
# a concrete comparable semver, or empty for unstamped/unavailable/blank
cb_real_ver() { case "$1" in ''|unstamped|unavailable) : ;; *) printf '%s' "$1" ;; esac; }
# stamped semver for $CLAUDE_IMAGE in a docker context ($1), or "" if unstamped/absent.
# Version-or-empty view over cb_image_status, for callers that just want a comparable
# version (e.g. cb_ensure_image's auto-reseed).
cb_image_version() { cb_real_ver "$(cb_image_status "$1")"; }

# `claudebox checkversion` — report the host wrapper's semver alongside the version
# baked into the claudebot image (cb-infra source + this project's VM), and warn on
# drift. Read-only: never boots a VM; reports down/unstamped distinctly.
# `checkversion --all` (#6, 2.23.0) also scans EVERY cb-* project VM's image, so drift
# is visible across the whole install (not just the current project).
# cb_completion_bash — emit a bash completion script for the wrapper's current binary
# name ($0's basename), so `DRIDOCK_BIN_NAME=dridock` reinstalls get a `_dridock`
# function bound to `dridock`. Called by the `completion bash` dispatch. install.sh
# drops the output into ~/.local/share/bash-completion/completions/<binname>. #13, 2.24.0.
cb_completion_bash() {
    local prog; prog="$(basename "$0")"
    cat <<COMP
# ${prog} bash completion — generated by \`${prog} completion bash\`.
# Install: ${prog} completion bash > ~/.local/share/bash-completion/completions/${prog}
# Then either restart bash or:  source ~/.local/share/bash-completion/completions/${prog}
_${prog}_complete() {
    local cur cword
    cur="\${COMP_WORDS[COMP_CWORD]}"
    cword=\$COMP_CWORD

    local top_verbs="start help version checkversion info status stop down destroy \\
clear-session bootstrap migrate setup-token completion browser-bridge host-agent \\
harness framework-bugs consult features profiles ip net vm mcp auth doctor \\
-h --help -v --version"

    if [ "\$cword" -le 1 ]; then
        COMPREPLY=( \$(compgen -W "\$top_verbs" -- "\$cur") )
        return 0
    fi

    case "\${COMP_WORDS[1]}" in
        vm)              COMPREPLY=( \$(compgen -W "ls list usage df gc" -- "\$cur") ) ;;
        browser-bridge)  COMPREPLY=( \$(compgen -W "up down" -- "\$cur") ) ;;
        host-agent)      COMPREPLY=( \$(compgen -W "up down status" -- "\$cur") ) ;;
        harness)
            if [ "\$cword" -eq 2 ]; then
                COMPREPLY=( \$(compgen -W "sync" -- "\$cur") )
            elif [ "\${COMP_WORDS[2]}" = "sync" ]; then
                COMPREPLY=( \$(compgen -W "--repair" -- "\$cur") )
            fi
            ;;
        framework-bugs)  COMPREPLY=( \$(compgen -W "list clear" -- "\$cur") ) ;;
        consult)         COMPREPLY=( \$(compgen -W "list show approve revise reject post watch" -- "\$cur") ) ;;
        completion)      COMPREPLY=( \$(compgen -W "bash" -- "\$cur") ) ;;
        checkversion)    COMPREPLY=( \$(compgen -W "--all" -- "\$cur") ) ;;
        migrate)         COMPREPLY=( \$(compgen -W "--all" -- "\$cur") ) ;;
        features|profiles) COMPREPLY=( \$(compgen -W "list enable disable info" -- "\$cur") ) ;;
        bootstrap)       COMPREPLY=( \$(compgen -W "--seed-secret --gh-token --secrets-file --brief-file --force --no-start --brief-only --adopt --workspace --multi-repo --repo" -- "\$cur") ) ;;
        destroy)         COMPREPLY=( \$(compgen -W "--purge" -- "\$cur") ) ;;
        start)           COMPREPLY=( \$(compgen -W "-p --output-format --model --system-prompt --append-system-prompt --json-schema --effort --resume --no-continue --update" -- "\$cur") ) ;;
        *)               COMPREPLY=() ;;
    esac
}
complete -F _${prog}_complete ${prog}
COMP
}

cb_checkversion() {
    local wv="$DRIDOCK_VERSION" civ pv cid ctx cmp ccv all=0
    while [ $# -gt 0 ]; do case "$1" in
        --all|-a) all=1 ;;
        -h|--help) echo "usage: dridock checkversion [--all]  (--all = scan every cb-* project VM in addition to cb-infra + this project)" >&2; return 0 ;;
        *) echo "checkversion: unknown arg '$1'" >&2; return 1 ;;
    esac; shift; done
    echo "dridock versions:"
    echo "  wrapper (host):        $wv"
    civ="$(cb_image_status "$(cb_infra_context)")"
    echo "  image (cb-infra):      $civ"
    cid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
    if [ -n "$cid" ]; then
        ctx="$(cb_project_context "$cid")"
        pv="$(cb_image_status "$ctx")"
        echo "  image (this project):  $pv   (VM $(cb_project_profile "$cid"))"
        # The baked Claude Code CLI — a separate axis from the harness semver, and the
        # one that decides which `claude` flags are real (#17). Auto-update is disabled
        # in the image on purpose, so this only moves on a rebuild.
        ccv="$(cb_image_claude_version "$ctx")"
        echo "  claude CLI (in image): $ccv"
        case "$ccv" in
            unavailable) : ;;
            *) if [ "$(cb_semver_cmp "$ccv" "$CB_CLAUDE_CLI_FLOOR")" = lt ]; then
                   echo "     ⚠️  older than $CB_CLAUDE_CLI_FLOOR — Remote Control (--remote-control) does not exist in" >&2
                   echo "        this CLI and claude IGNORES unknown flags silently. Rebuild: make build" >&2
               fi ;;
        esac
    else
        pv=""
        echo "  image (this project):  <no dridock project in $PWD>"
    fi
    if [ "$all" = 1 ]; then
        echo ""
        echo "  all cb-* project VMs (--all):"
        local rows other_vms this_profile="" p pver
        [ -n "$cid" ] && this_profile="$(cb_project_profile "$cid")"
        rows="$(_cb_vm_list_json | cb_parse_vm_lines)"
        other_vms="$(printf '%s\n' "$rows" | awk -F'\t' -v self="$this_profile" '$1 ~ /^cb-/ && $1 != "cb-infra" && $1 != self { print $1 }')"
        if [ -z "$other_vms" ]; then
            echo "    (none besides this project)"
        else
            while IFS= read -r p; do
                [ -z "$p" ] && continue
                pver="$(cb_image_status "colima-$p")"
                printf '    %-24s %s\n' "$p" "$pver"
            done <<<"$other_vms"
        fi
    fi
    echo ""
    local pver cver; pver="$(cb_real_ver "$pv")"; cver="$(cb_real_ver "$civ")"
    # Case: the image is already BUILT current (cb-infra == wrapper) but this project's
    # VM still runs an older/unstamped image — it just needs a reseed, NOT a rebuild.
    # Say exactly that (running `dridock start` here auto-reseeds + recreates) and stop, so
    # we don't also print misleading "make build" advice.
    if [ -n "$cid" ] && [ -n "$cver" ] && [ "$cver" = "$wv" ] && [ "$pver" != "$cver" ]; then
        echo "ℹ️  cb-infra is current ($cver); this project's VM still runs ${pver:-$pv}."
        echo "   → run 'dridock start' in this project — it auto-reseeds $cver and recreates the container"
        echo "     (session preserved). No rebuild needed."
        return 0
    fi
    cmp="${pver:-$cver}"
    if [ -z "$cmp" ]; then
        if [ "$pv" = unstamped ] || [ "$civ" = unstamped ]; then
            echo "ℹ️  the claudebot image predates versioning (no stamp). Rebuild to stamp it: make build"
        else
            echo "ℹ️  no built image reachable to compare (VMs down / not built yet): make build"
        fi
        return 0
    fi
    if [ "$cmp" = "$wv" ]; then
        echo "✅ in sync — wrapper and claudebot image are both $wv."
        return 0
    fi
    # classify how urgent a rebuild/update is by WHERE the versions first differ
    echo "⚠️  version drift: wrapper $wv vs claudebot image $cmp."
    case "$(cb_semver_severity "$wv" "$cmp")" in
        major) echo "   🔴 MAJOR drift — rebuild/update REQUIRED (breaking IPC-contract change; peers may be incompatible)." ;;
        minor) echo "   🟠 MINOR drift — you SHOULD rebuild/update (new features / additive contract change; still compatible)." ;;
        patch) echo "   🟡 PATCH drift — rebuild OPTIONAL (fixes/docs only, no contract change)." ;;
    esac
    case "$(cb_semver_cmp "$wv" "$cmp")" in
        gt) echo "      host wrapper is newer → rebuild the image, then restart:  make build" ;;
        lt) echo "      claudebot image is newer → update the host wrapper:  ./install.sh" ;;
    esac
    return 0
}

# `claudebox info` — a human-facing at-a-glance summary for the CURRENT project:
# versions, the paths that matter (config, secrets, data dir), the VM + network, and
# where to browse. Read-only and fast: reads state, never boots a VM or polls. $1=root.
cb_info() {
    local root="$1" id ctx profile status ip host cfg sf dd pv civ cname cstat keys
    id="$(cb_project_id_ro "$root")"
    echo "dridock — info"
    echo ""
    echo "versions:"
    printf '  %-18s %s   (%s)\n' "wrapper (host):" "$DRIDOCK_VERSION" "$(command -v claudebox 2>/dev/null || echo "$0")"
    civ="$(cb_image_status "$(cb_infra_context)")"
    printf '  %-18s %s\n' "image (cb-infra):" "$civ"
    if [ -n "$id" ]; then
        ctx="$(cb_project_context "$id")"; profile="$(cb_project_profile "$id")"
        printf '  %-18s %s\n' "image (project):" "$(cb_image_status "$ctx")"
    fi
    echo ""
    echo "project:"
    printf '  %-18s %s\n' "workspace:" "$root"
    if [ -z "$id" ]; then
        echo "  (not a dridock project yet — run 'dridock start' here to initialize)"
    else
        status="$(cb_vm_status "$profile")"
        printf '  %-18s %s\n' "project id:" "$id"
        printf '  %-18s %s   (%s)\n' "VM:" "$profile" "$status"
        printf '  %-18s %s\n' "config.yml:" "$(cb_project_config_path "$root")"
        sf="$(cb_secrets_path "$root")"
        if [ -f "$sf" ]; then keys="$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$sf" 2>/dev/null)"
            printf '  %-18s %s   (%s key(s), chmod %s)\n' "secrets.env:" "$sf" "${keys:-0}" "$(stat -c '%a' "$sf" 2>/dev/null)"
        else printf '  %-18s %s\n' "secrets.env:" "(none — 'dridock bootstrap --seed-secret KEY=CMD' or add .dridock/secrets.env)"; fi
        printf '  %-18s %s\n' "data dir:" "$(cb_project_data_dir "$id")   (session history, settings, plugins)"
        cname="claude-$(printf '%s' "$PWD" | sed 's#/#_#g')"
        cstat="$(docker --context "$ctx" ps -a --filter "name=^${cname}\$" --format '{{.Status}}' 2>/dev/null | head -1)"
        printf '  %-18s %s   %s\n' "container:" "$cname" "${cstat:-<none>}"
        echo ""
        echo "network:"
        ip="$(cb_vm_address "$profile")"; host="$(cb_project_hostname "$root")"
        if [ -n "$ip" ]; then
            printf '  %-18s %s\n' "VM IP:" "$ip"
            printf '  %-18s %s\n' "browse:" "http://$ip:<port>   (or http://localhost:<port>, collides across projects)"
        else
            printf '  %-18s %s\n' "VM IP:" "(VM not running — start with 'dridock')"
        fi
        if [ -n "$host" ]; then printf '  %-18s %s   → http://%s:<port>   ('\''dridock net'\'' for the /etc/hosts line)\n' "hostname:" "$host" "$host"
        else printf '  %-18s %s\n' "hostname:" "(unset — set network.hostname in config.yml for a friendly name)"; fi
        printf '  %-18s %s\n' "cb-net:" "cb-net   (attach sibling workloads: docker run --network cb-net ...)"
    fi
    echo ""
    echo "machine:"
    printf '  %-18s %s\n' "machine config:" "$(cb_machine_config_path)"
    printf '  %-18s %s\n' "data root:" "$(cb_data_root)"
    printf '  %-18s %s   (%s)\n' "cb-infra:" "$(cb_vm_status "$CB_INFRA_PROFILE")" "image store"
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

# cb_inject_vm_env ID ROOT — populate the VM-IP env for the claudebot container.
# MUST be called AFTER cb_ensure_vm (needs the VM up). Writes a per-role sidecar
# ~/.claude/.<container>{,_prog,_cron}-vmip that entrypoint.sh re-reads on every
# `docker start` (rotation-proof self-heal) and appends -e DRIDOCK_VM_IP /
# DRIDOCK_HOSTNAME to DOCKER_ARGS so a fresh `docker run` sees them too.
# Uses cb_wait_reachable (not the raw cb_vm_address) because col0 reachability
# lags `colima start --network-address` by a couple of seconds — a plain lookup
# racing a fresh boot returns empty, which was the pre-fix first-run bug. Reads
# DOCKER_ARGS, container_name, CLAUDE_DIR from caller scope.
cb_inject_vm_env() {
    local id="$1" root="$2" profile ip host _crole
    profile="$(cb_project_profile "$id")"
    ip="$(cb_wait_reachable "$profile" 2>/dev/null || true)"
    host="$(cb_project_hostname "$root" 2>/dev/null || true)"
    [ -n "$ip" ]   && DOCKER_ARGS+=(-e "DRIDOCK_VM_IP=$ip")
    [ -n "$host" ] && DOCKER_ARGS+=(-e "DRIDOCK_HOSTNAME=$host")
    for _crole in "" _prog _cron; do
        { printf 'DRIDOCK_VM_IP=%s\n' "$ip"
          printf 'DRIDOCK_HOSTNAME=%s\n' "$host"; } \
            > "$CLAUDE_DIR/.${container_name}${_crole}-vmip"
    done
}

# read the `features:` list from .dridock/config.yml -> space-separated names. Also
# reads `profiles:` for one deprecation cycle (2.x → 3.0) — either key means the
# same thing. Supports flow style (`features: [typescript, go]`) and block style
# (`features:` then `- name`). Names are validated; the entrypoint maps each to a
# baked on.sh under /usr/local/lib/dridock/features/<name>/.
cb_project_features() {
    local cfg; cfg="$(cb_project_config_path "$1")"
    [ -f "$cfg" ] || return 0
    awk '
        /^[[:space:]]*(features|profiles):[[:space:]]*\[/ {
            s=$0; sub(/^[^[]*\[/,"",s); sub(/\].*/,"",s);
            n=split(s,a,","); for(i=1;i<=n;i++){ gsub(/[^A-Za-z0-9_-]/,"",a[i]); if(a[i]!="") print a[i] }
            inblock=0; next
        }
        /^[[:space:]]*(features|profiles):[[:space:]]*(#.*)?$/ { inblock=1; next }
        inblock && /^[[:space:]]*-[[:space:]]*/ { s=$0; sub(/^[[:space:]]*-[[:space:]]*/,"",s); sub(/[[:space:]]*#.*/,"",s); gsub(/[^A-Za-z0-9_-]/,"",s); if(s!="") print s; next }
        inblock && /^[[:space:]]*(#.*)?$/ { next }
        inblock { inblock=0 }
    ' "$cfg" | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}
# One-deprecation-cycle alias for external callers / tests that still read the old name.
cb_project_profiles() { cb_project_features "$@"; }

# cb_features_list ROOT — `dridock features list` (default action). Enabled + available.
# Available is queried from the image (features/<name>/manifest.yml description); falls
# back to a 2.x profiles/*.sh scan for one deprecation cycle.
cb_features_list() {
    local root="$1" enabled avail _dotname
    enabled="$(cb_project_features "$root")"
    _dotname="$(cb_project_dot_basename "$root")"
    echo "enabled for this project (${_dotname}/config.yml → features:):"
    if [ -n "$enabled" ]; then printf '  %s\n' $enabled
    else echo "  (none — add e.g.  features: [typescript, python]  to ${_dotname}/config.yml, or run 'dridock features enable typescript')"; fi
    echo ""
    # `awk` reads each manifest.yml one-liner description; legacy profiles/*.sh with a
    # `# summary:` header is read as fallback so images built before this feature-system
    # change still list something useful.
    avail="$(docker --context "$(cb_infra_context)" run --rm --entrypoint sh "$CLAUDE_IMAGE" -c \
        'for d in /usr/local/lib/dridock/features/*/; do [ -d "$d" ] || continue; n="$(basename "$d")"; dsc="$(awk -F: "/^description:/{sub(/^[^:]*:[[:space:]]*/,\"\"); print; exit}" "$d/manifest.yml" 2>/dev/null)"; printf "%s\t%s\n" "$n" "${dsc:-—}"; done
         for f in /usr/local/lib/dridock/profiles/*.sh /usr/local/lib/claudebox/profiles/*.sh; do [ -f "$f" ] || continue; printf "%s\t%s\n" "$(basename "$f" .sh)" "(legacy 2.x profile) $(sed -n "s/^# summary: //p" "$f" | head -1)"; done' 2>/dev/null | sort -u -k1,1)"
    if [ -n "$avail" ]; then
        echo "available (baked in the image):"
        printf '%s\n' "$avail" | awk -F'\t' '{printf "  %-14s %s\n", $1, $2}'
    else
        echo "available: (build the image to list — see docs/design/features-system.md)"
    fi
    echo ""
    echo "enable / disable: 'dridock features enable <name>' / 'dridock features disable <name>'"
}

# cb_features_info ROOT NAME — print the manifest for a baked feature. Runs in a
# throwaway container against the image; best-effort.
cb_features_info() {
    local root="$1" name="$2"
    case "$name" in ''|*[!A-Za-z0-9_-]*) echo "features info: bad name '$name'" >&2; return 1 ;; esac
    docker --context "$(cb_infra_context)" run --rm --entrypoint sh "$CLAUDE_IMAGE" -c \
        "d=/usr/local/lib/dridock/features/$name; if [ -f \"\$d/manifest.yml\" ]; then echo '--- manifest.yml ---'; cat \"\$d/manifest.yml\"; for s in on.sh off.sh bake.sh; do [ -f \"\$d/\$s\" ] && echo \"--- \$s ---\" && head -20 \"\$d/\$s\"; done; else legacy=/usr/local/lib/dridock/profiles/$name.sh; [ -f \"\$legacy\" ] && { echo '(legacy 2.x profile — has no manifest)'; head -20 \"\$legacy\"; } || { echo \"features info: unknown feature '$name' (no /usr/local/lib/dridock/features/$name/manifest.yml or legacy profile)\" >&2; exit 1; }; fi" 2>&1
}

# cb_features_write ROOT NAMES — rewrite the `features:` block in .dridock/config.yml
# to NAMES (space-separated). Removes both `features:` and `profiles:` blocks first
# (either flow or block style), then appends a single `features: [n1, n2, …]` flow
# entry. Empty NAMES removes the block entirely. Portable rewrite via temp file.
cb_features_write() {
    local root="$1" names="$2" cfg tmp
    cfg="$(cb_project_config_path "$root")"
    [ -f "$cfg" ] || { echo "no config.yml at $cfg — run 'dridock start' first to initialize" >&2; return 1; }
    tmp="$(mktemp)"
    # Strip existing features:/profiles: (flow OR block form) — preserve everything else.
    awk '
        /^[[:space:]]*(features|profiles):[[:space:]]*\[/ { next }
        /^[[:space:]]*(features|profiles):[[:space:]]*(#.*)?$/ { skip=1; next }
        skip && /^[[:space:]]*-[[:space:]]*/ { next }
        skip && /^[[:space:]]*(#.*)?$/ { next }
        skip { skip=0 }
        { print }
    ' "$cfg" > "$tmp"
    if [ -n "$names" ]; then
        # Trim trailing blanks; append a single flow-style features: line.
        awk 'NF{p=1} p{buf=buf$0"\n"} END{sub(/\n+$/,"",buf); print buf}' "$tmp" > "$tmp.trim"
        mv "$tmp.trim" "$tmp"
        # names come space-separated; render as [a, b, c]
        set -- $names
        local flow=""
        while [ $# -gt 0 ]; do flow="$flow, $1"; shift; done
        flow="${flow#, }"
        printf '\nfeatures: [%s]\n' "$flow" >> "$tmp"
    fi
    cat "$tmp" > "$cfg"
    rm -f "$tmp"
}

# cb_features_enable ROOT NAME — add NAME to features: in .dridock/config.yml.
# Idempotent; validates NAME. Runs on.sh immediately if the project's container is up.
cb_features_enable() {
    local root="$1" name="$2" existing new
    case "$name" in ''|*[!A-Za-z0-9_-]*) echo "features enable: bad name '$name'" >&2; return 1 ;; esac
    existing="$(cb_project_features "$root")"
    # Already enabled? no-op.
    case " $existing " in *" $name "*) echo "  ✓ $name already enabled"; return 0 ;; esac
    new="$(printf '%s %s' "$existing" "$name" | awk '{$1=$1; print}')"
    cb_features_write "$root" "$new" || return 1
    echo "  ✓ enabled feature '$name' (${new// /, }). On next 'dridock' run, on.sh installs it."
}

# cb_features_disable ROOT NAME — remove NAME from features:, drop the enable marker
# in the project's data dir, and run off.sh immediately in the container if it's up.
cb_features_disable() {
    local root="$1" name="$2" existing new id data_dir marker off_script rc
    case "$name" in ''|*[!A-Za-z0-9_-]*) echo "features disable: bad name '$name'" >&2; return 1 ;; esac
    existing="$(cb_project_features "$root")"
    case " $existing " in *" $name "*) : ;;
        *) echo "  ℹ $name isn't in features: — nothing to disable"; return 0 ;;
    esac
    # Rebuild list without NAME.
    new=""; for f in $existing; do [ "$f" = "$name" ] || new="$new $f"; done
    new="${new# }"
    cb_features_write "$root" "$new" || return 1
    # Clear the enable marker (both 3.0 and legacy 2.x names) so re-enabling replays on.sh.
    id="$(cb_project_id_ro "$root")"
    if [ -n "$id" ]; then
        data_dir="$(cb_project_data_dir "$id")"
        rm -f "$data_dir/.feature-$name" "$data_dir/.profile-$name" 2>/dev/null || true
    fi
    # Best-effort: run off.sh in the running container. Silent on failure — the
    # config change + marker removal alone is enough to disable on the next start.
    off_script="/usr/local/lib/dridock/features/$name/off.sh"
    local off_note="off.sh will run on next container start"
    if [ -n "$id" ]; then
        local cname="claude-$(printf '%s' "$root" | sed 's#/#_#g')"
        if docker --context "$(cb_project_context "$id")" exec "$cname" bash -c "[ -x '$off_script' ] && '$off_script'" >/dev/null 2>&1; then
            off_note="off.sh ran in the container"
        fi
    fi
    echo "  ✓ disabled feature '$name'${new:+ (remaining: ${new// /, })}. $off_note."
}

# cb_features_cmd — top-level dispatch for `dridock features [list|enable|disable|info]`.
# `list` is the default action if no sub-verb is passed.
cb_features_cmd() {
    local root="$1"; shift
    case "${1:-list}" in
        ""|list)   cb_features_list "$root" ;;
        enable)    shift; [ -n "${1:-}" ] || { echo "usage: dridock features enable <name>" >&2; return 1; }
                   cb_features_enable "$root" "$1" ;;
        disable)   shift; [ -n "${1:-}" ] || { echo "usage: dridock features disable <name>" >&2; return 1; }
                   cb_features_disable "$root" "$1" ;;
        info)      shift; [ -n "${1:-}" ] || { echo "usage: dridock features info <name>" >&2; return 1; }
                   cb_features_info "$root" "$1" ;;
        -h|--help)
            echo "usage: dridock features [list | enable <name> | disable <name> | info <name>]"
            echo "  list                    show enabled + available features (default)"
            echo "  enable <name>           add <name> to features: in .dridock/config.yml"
            echo "  disable <name>          remove <name> from features: (runs the feature's off.sh)"
            echo "  info <name>             print the feature's manifest.yml"
            echo ""
            echo "  'dridock profiles' is an alias for one deprecation cycle (2.x → 3.0)."
            echo "  Full design: docs/design/features-system.md" ;;
        *) echo "features: unknown sub-verb '$1' (try: dridock features --help)" >&2; return 1 ;;
    esac
}

# Legacy alias kept for one deprecation cycle. Prints a one-line deprecation notice
# on stderr the first time it's used per session — non-fatal, easy to silence.
cb_profiles_cmd() {
    echo "ℹ 'dridock profiles' is a legacy alias — use 'dridock features' (removed in 4.0)." >&2
    cb_features_cmd "$@"
}

# cb_set_hostname ROOT NAME — set network.hostname in .dridock/config.yml (so
# `dridock net` can then print the /etc/hosts line). Validated to hostname chars;
# portable rewrite via temp file (no sed -i). $1=root $2=name.
cb_set_hostname() {
    local root="$1" name="$2" cfg tmp _dotname
    case "$name" in ''|*[!a-zA-Z0-9._-]*) echo "invalid hostname '$name' (letters, digits, '.', '-', '_' only)" >&2; return 1 ;; esac
    cfg="$(cb_project_config_path "$root")"
    _dotname="$(cb_project_dot_basename "$root")"
    [ -f "$cfg" ] || { echo "no ${_dotname}/config.yml here — run 'dridock start' first to initialize" >&2; return 1; }
    tmp="$(mktemp)"
    if grep -qE '^[[:space:]]*hostname:' "$cfg"; then
        sed -E "s|^([[:space:]]*)hostname:.*|\\1hostname: $name|" "$cfg" > "$tmp" && cat "$tmp" > "$cfg"
    else
        cat "$cfg" > "$tmp"; printf 'network:\n  hostname: %s\n' "$name" >> "$tmp"; cat "$tmp" > "$cfg"
    fi
    rm -f "$tmp"
    echo "  ✓ set network.hostname: $name  (${_dotname}/config.yml)"
}

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
        echo "🌐 VM $profile has no reachable IP yet (is it running? try 'dridock')."
        return 0
    fi
    echo "🌐 project VM $profile: $ip"
    echo "   browse a published workload at  http://$ip:<port>  (or http://localhost:<port>, colima-forwarded but collides across projects)"
    host="$(cb_project_hostname "$root")"
    if [ -z "$host" ]; then
        local suggest; suggest="$(basename "$root")"
        echo "   no network.hostname set (so no friendly name yet). To add one, run:"
        echo "       dridock net $suggest"
        echo "   — that sets it, then prints a one-line /etc/hosts entry for http://$suggest:<port>"
        return 0
    fi
    line="$ip  $host"
    case "$(cb_hosts_status /etc/hosts "$host" "$ip")" in
        ok)      echo "   /etc/hosts: $host → $ip ✓   browse  http://$host:<port>" ;;
        missing) echo "   add to /etc/hosts (dridock won't edit it — one-time, your call):"
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
CB_CDP_PORT="${DRIDOCK_CDP_PORT:-9223}"                 # forwarder listen (Mac side)
CB_CDP_CHROME_PORT="${DRIDOCK_CDP_CHROME_PORT:-9222}"   # Chrome --remote-debugging-port
CB_CDP_BIND="${DRIDOCK_CDP_BIND:-192.168.64.1}"         # Mac reachable-net gateway (colima-only, not LAN)
cb_cdp_home() { _cb_state_home cdp; }
cb_cdp_marker() { printf '%s/projects/%s/.cdp-url' "$(cb_xdg_dir)" "$1"; }  # $1=id
# The dedicated debug-Chrome user-data-dir. One shared bridge (single Chrome + fixed
# forwarder port) serves every project, so this is intentionally global, not per-id.
# Tunable: point DRIDOCK_CDP_PROFILE at your own throwaway dir to relocate/rename it.
# NOTE: never aim it at your normal Chrome profile — the bridge hands claudebot full
# control of that instance. Default name says what it is if you spot it on disk.
cb_cdp_profile() { printf '%s' "${DRIDOCK_CDP_PROFILE:-$(cb_cdp_home)/chrome-debug-profile}"; }

# Shared cross-project sink for FRAMEWORK bug reports (cb-report-bug inside the
# container writes here; `claudebox framework-bugs` reads it). Deliberately shared
# across all projects — framework feedback spans projects, unlike per-project data.
cb_fwbugs_home() { _cb_state_home framework-bugs; }

# Shared cross-project sink for CONSULTS — supervised claudebot<->framework-Claude
# threads (cb-consult in the container + `claudebox consult` on the host both read/write
# here). See docs/design/framework-consult.md. Shared like framework-bugs; all files.
cb_consult_home() { _cb_state_home consult; }

# cb_consult_status DIR/<id> — echo a thread's status (from its meta), or "" if none.
cb_consult_status() { local m="$1/meta"; [ -f "$m" ] && sed -n 's/^status=//p' "$m" | tail -1; }

# cb_consult_meta_set DIR/<id> KEY VALUE — set/replace KEY in a thread's meta file.
cb_consult_meta_set() {
    local td="$1" k="$2" v="$3" m="$1/meta"
    mkdir -p "$td"; touch "$m"
    if grep -q "^${k}=" "$m" 2>/dev/null; then sed -i "s#^${k}=.*#${k}=${v}#" "$m"
    else printf '%s=%s\n' "$k" "$v" >> "$m"; fi
    grep -q '^updated=' "$m" && sed -i "s#^updated=.*#updated=$(date +%Y-%m-%dT%H-%M-%S)#" "$m" || printf 'updated=%s\n' "$(date +%Y-%m-%dT%H-%M-%S)" >> "$m"
}

# cb_consult_post DIR/<id> AUTHOR  (body on stdin) — append the next numbered turn.
cb_consult_post() {
    local td="$1" author="$2" n next
    mkdir -p "$td"
    n=$(find "$td" -maxdepth 1 -name '[0-9][0-9][0-9]-*.md' 2>/dev/null | wc -l | tr -d ' ')
    next=$(printf '%03d' $((n + 1)))
    cat > "$td/${next}-${author}.md"
}

# cb_consult_sig HOME [PROJECT] — a stable one-line-per-thread signature (id|status|nturns)
# of all threads (optionally filtered to a project id). `watch` diffs this to detect change.
cb_consult_sig() {
    local ch="$1" filt="${2:-}" td m n
    [ -d "$ch" ] || return 0
    for td in "$ch"/*/; do
        [ -d "$td" ] || continue; td="${td%/}"; m="$td/meta"; [ -f "$m" ] || continue
        [ -z "$filt" ] || [ "$(sed -n 's/^project=//p' "$m" | head -1)" = "$filt" ] || continue
        n=$(find "$td" -maxdepth 1 -name '[0-9][0-9][0-9]-*.md' 2>/dev/null | wc -l | tr -d ' ')
        printf '%s|%s|%s\n' "$(basename "$td")" "$(sed -n 's/^status=//p' "$m" | tail -1)" "$n"
    done | sort
}

cb_bridge_up() {   # $1=id
    local id="$1" chrome home profile fwd url
    chrome="${DRIDOCK_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
    [ -x "$chrome" ] || { echo "❌ Chrome not found at: $chrome (set DRIDOCK_CHROME)" >&2; return 1; }
    home="$(cb_cdp_home)"; mkdir -p "$home"; profile="$(cb_cdp_profile)"; fwd="$home/forward.py"
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
    # Generate/persist an 8-hex-digit instance hash and open the initial tab with a
    # data URL whose <title> is "Claudebox Chrome -- <hash>". macOS Chrome's window
    # title mirrors the active tab's <title>, so this makes the debug window
    # identifiable in Mission Control / Cmd+Tab / Dock tooltip. The hash lives in a
    # file so a second `browser-bridge up` (without an intervening `down`) reuses it.
    # Refresh policy (#3): fresh identity per bridge SESSION, not stable-across-reboot —
    # if `pids` is missing or points at dead processes (Mac reboot, Chrome closed, VM
    # restart), we're launching a new Chrome, so regenerate the hash. Reuse only if the
    # bridge is still live (a second `up` while running).
    local hash_file="$home/window-hash" hash window_title welcome_url
    if ! { [ -f "$home/pids" ] && kill -0 $(cat "$home/pids") 2>/dev/null; }; then
        od -An -N4 -tx1 /dev/urandom | tr -d ' \n' > "$hash_file"
    fi
    [ -s "$hash_file" ] || od -An -N4 -tx1 /dev/urandom | tr -d ' \n' > "$hash_file"
    hash="$(cat "$hash_file")"
    window_title="Claudebox Chrome -- $hash"
    welcome_url="data:text/html;charset=utf-8,<html><head><title>${window_title}</title></head><body style='font-family:-apple-system;padding:2em;color:#333;max-width:44em;margin:auto'><h1 style='color:#c05621'>${window_title}</h1><p>This is the claudebot's <b>dedicated CDP debug Chrome</b>. It's driven by <code>cb-browser cdp</code> / <code>cb-browser script-cdp</code> via the CDP bridge on <code>$CB_CDP_BIND:$CB_CDP_PORT</code>.</p><p style='color:#888;font-size:0.9em'>If you navigate this tab, the window title changes to match — leave this tab open (or reopen this URL) if you want the marker back.</p></body></html>"

    if [ -f "$home/pids" ] && kill -0 $(cat "$home/pids") 2>/dev/null; then
        echo "🔗 CDP bridge already running"
    else
        # --remote-allow-origins=* : Chrome >=111 rejects the CDP WebSocket upgrade
        # from a disallowed Origin; without this, Playwright connectOverCDP can 403.
        "$chrome" --remote-debugging-port="$CB_CDP_CHROME_PORT" --user-data-dir="$profile" \
            --remote-allow-origins='*' \
            --no-first-run --no-default-browser-check "$welcome_url" >/dev/null 2>&1 &
        local cpid=$!
        sleep 2
        python3 "$fwd" >"$home/forward.log" 2>&1 &
        local fpid=$!
        echo "$cpid $fpid" > "$home/pids"
    fi
    url="http://$CB_CDP_BIND:$CB_CDP_PORT"
    local marker; marker="$(cb_cdp_marker "$id")"; mkdir -p "$(dirname "$marker")"; printf '%s' "$url" > "$marker"
    echo "🔗 CDP bridge up — dedicated debug Chrome window \"$window_title\" is open; claudebot can drive it."
    echo "   in claudebot:  cb-browser cdp <url>   (uses DRIDOCK_HOST_CDP_URL=$url)"
    echo "   ⚠️  targets must be reachable FROM THIS MAC (VM IP or localhost) — the human's"
    echo "       Chrome can't resolve cb-net container names; use shot/script for those."
    echo "   profile: $profile   (override with DRIDOCK_CDP_PROFILE)"
    echo "   restart claudebot (just re-run \`claudebox\`) to pick up the bridge URL."
    echo "   stop:  dridock browser-bridge down"
    echo "   ⚠️  this hands claudebot full control of that Chrome instance (dedicated profile)."
}

cb_bridge_down() {  # $1=id
    local id="$1" home; home="$(cb_cdp_home)"
    [ -f "$home/pids" ] && { kill $(cat "$home/pids") 2>/dev/null; rm -f "$home/pids"; }
    rm -f "$home/window-hash"   # fresh instance hash on next `up`
    rm -f "$(cb_cdp_marker "$id")"
    echo "🔗 CDP bridge down"
}

# ─────────────────────────────────────────────────────────────────────────────
# Host agent (Approach 2, phase 1) — proxy the framework's host-only commands
# (colima/limactl) from a harness-DEV claudebot back to the Mac. OPT-IN, off by default, and
# a TRUSTED single-operator tool (remote command exec). Gateway-bound + token-auth +
# subcommand-allowlisted (see host-agent.py). See docs/design/backends.md.
# ─────────────────────────────────────────────────────────────────────────────
CB_HOST_AGENT_PORT="${DRIDOCK_HOST_AGENT_PORT:-9280}"
CB_HOST_AGENT_BIND="${DRIDOCK_HOST_AGENT_BIND:-192.168.64.1}"   # Colima gateway only, never LAN
cb_host_agent_home() { _cb_state_home host-agent; }
# resolve host-agent.py: env override → next to the wrapper → the share dir → the repo.
cb_host_agent_py() {
    local d; d="$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"
    for _p in "${DRIDOCK_HOST_AGENT_PY:-}" "$d/host-agent.py" "$d/../share/claudebox/host-agent.py"; do
        [ -n "$_p" ] && [ -f "$_p" ] && { printf '%s' "$_p"; return 0; }
    done
    return 1
}
cb_host_agent_up() {
    local home py tok; home="$(cb_host_agent_home)"; mkdir -p "$home"
    py="$(cb_host_agent_py)" || { echo "❌ host-agent.py not found (set DRIDOCK_HOST_AGENT_PY, or reinstall)" >&2; return 1; }
    if [ -f "$home/pid" ] && kill -0 "$(cat "$home/pid" 2>/dev/null)" 2>/dev/null; then
        echo "🛰  host agent already up ($CB_HOST_AGENT_BIND:$CB_HOST_AGENT_PORT)"; return 0
    fi
    tok="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '%s' "$tok" > "$home/token"; chmod 600 "$home/token"
    CB_HOST_AGENT_TOKEN="$tok" CB_HOST_AGENT_BIND="$CB_HOST_AGENT_BIND" CB_HOST_AGENT_PORT="$CB_HOST_AGENT_PORT" \
        nohup python3 "$py" >"$home/log" 2>&1 &
    echo $! > "$home/pid"
    sleep 1
    if kill -0 "$(cat "$home/pid")" 2>/dev/null; then
        echo "🛰  host agent up on $CB_HOST_AGENT_BIND:$CB_HOST_AGENT_PORT (allowlisted colima/limactl)"
        echo "   ⚠️  this lets a claudebot run allowlisted colima/limactl ON YOUR MAC — trusted harness dev only."
        echo "   restart your dev claudebot to pick up the agent; stop:  dridock host-agent down"
    else
        echo "❌ host agent failed to start — see $home/log" >&2; tail -3 "$home/log" >&2; return 1
    fi
}
cb_host_agent_down() {
    local home; home="$(cb_host_agent_home)"
    [ -f "$home/pid" ] && { kill "$(cat "$home/pid")" 2>/dev/null; rm -f "$home/pid"; }
    rm -f "$home/token"
    echo "🛰  host agent down"
}
cb_host_agent_status() {
    local home; home="$(cb_host_agent_home)"
    if [ -f "$home/pid" ] && kill -0 "$(cat "$home/pid" 2>/dev/null)" 2>/dev/null; then
        echo "host agent: UP ($CB_HOST_AGENT_BIND:$CB_HOST_AGENT_PORT, pid $(cat "$home/pid"))"
    else echo "host agent: down (enable with 'dridock host-agent up')"; fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap — hand off *intent* from host-Claude into a new claudebot project.
# See docs/design/bootstrap.md. `dridock bootstrap` scaffolds a project and
# writes a durable, COMMITTED mission brief (.dridock/BRIEF.md) so claudebot
# boots knowing WHY it was created. Full scaffolder by default; --brief-only for
# just the brief + config.
# ─────────────────────────────────────────────────────────────────────────────
cb_brief_path() { printf '%s/BRIEF.md' "$(cb_project_dot "$1")"; }  # $1=root; COMMITTED (unlike config.yml)

# cb_preflight MODE — assert the host tooling a claudebot project needs is in place
# BEFORE we scaffold or boot. HARD requirements (colima, docker; git for full mode)
# abort; recommended tools (python3, socket_vmnet) only warn. This is the "check the
# ground before building on it" gate. Override with DRIDOCK_SKIP_PREFLIGHT=1.
cb_preflight() {
    local mode="${1:-full}" missing=0 t
    [ -n "${DRIDOCK_SKIP_PREFLIGHT:-}" ] && return 0
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
    if [ -x "${DRIDOCK_SOCKET_VMNET:-/opt/local/bin/socket_vmnet}" ]; then echo "  ✓ socket_vmnet"
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
        echo "❌ preflight: $missing required tool(s) missing — install them, or set DRIDOCK_SKIP_PREFLIGHT=1 to override" >&2
        return 1
    fi
    return 0
}

# cb_write_brief ROOT INTENT [FLAVOR] — (re)write the standard mission brief.
#   FLAVOR = adopt (existing repo) | workspace (multi-repo) | "" (greenfield).
cb_write_brief() {
    local root="$1" intent="$2" flavor="${3:-}" brief name when extra_note=""
    brief="$(cb_brief_path "$root")"; name="$(basename "$root")"
    when="$(date +%Y-%m-%d 2>/dev/null || echo 'unknown date')"
    [ -n "$intent" ] || intent="_TODO: state why this project exists — the goal Alan/host-Claude set. Replace this line._"
    case "$flavor" in
      adopt) extra_note="
## The codebase (adopted)

This project ADOPTS an existing repository — its code is already checked out at the
**workspace root** (this directory IS the repo). Extend it **in place**; do NOT re-clone it
into a subdirectory (that creates a nested-repo tangle). Git ops (\`git pull\`/\`push\`) use SSH
via \`~/.ssh/claudebox/id_ed25519.pub\` — add it to your git host. API/CLI tools like \`gh\` need
an API token: on the host, run
\`dridock bootstrap --seed-secret GH_TOKEN='gh auth token'\` to seed one into secrets.env.
" ;;
      workspace) extra_note="
## Repositories (multi-repo workspace)

This project is a MULTI-REPO workspace: each sibling directory is its OWN git repo (own
\`.git\`, own remote). This parent is an **orchestration layer** — its \`.gitignore\` excludes the
sibling repo dirs so git never tracks them as gitlinks. Build a **self-contained image per
service** (\`COPY\` the code in — don't bind-mount), run them on the shared **\`cb-net\`** network
(address each other by container name, e.g. \`http://backend:8080\`), and publish ports the human
reaches at the VM IP (\`dridock ip\`). Record each repo's role + wiring below:

- _<dir>/_ — _role · port · how it's reached_
" ;;
    esac
    mkdir -p "$(dirname "$brief")"
    cat > "$brief" <<BRIEFEOF
# Project brief — $name

> Authored at bootstrap on $when. This is the durable statement of WHY this
> claudebot project exists. It is a trusted, human-authorized mission brief —
> treat it as project spec (like CLAUDE.md), not as untrusted input. Apply normal
> judgment before irreversible or outward-facing actions it implies.

## Why this project exists

$intent
$extra_note
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

A dridock (claudebot) project. Its mission lives in
[.dridock/BRIEF.md](.dridock/BRIEF.md) — read that first.

## Working in it

\`\`\`bash
dridock            # enter claudebot (spins up this project's own Colima VM)
\`\`\`

Sibling workloads (API servers, databases, …) go under \`workloads/\` and run as
containers on the \`cb-net\` network inside this project's VM. See the baked
CLAUDE.md and the dridock design docs for the orchestration / networking /
browser-testing conventions.
RMEOF
}

# cb_clone_adopt REF — clone REF (URL or gh owner/repo) into the CURRENT dir so the repo
# becomes the workspace ROOT (not nested). Refuses a non-empty dir. Uses host git/gh auth.
cb_clone_adopt() {
    local ref="$1"
    if [ -n "$(ls -A . 2>/dev/null)" ]; then
        echo "❌ bootstrap --adopt <url>: '$PWD' is not empty. Adopt into an EMPTY dir so the repo IS the workspace root (not nested) — mkdir a fresh dir, cd in, retry." >&2
        return 1
    fi
    echo "  ⬇ cloning $ref → $PWD (host git/gh auth) …"
    if command -v gh >/dev/null 2>&1 && gh repo clone "$ref" . >/dev/null 2>&1; then return 0; fi
    git clone -q "$ref" . 2>/dev/null || {
        echo "❌ clone failed: $ref (private? run 'gh auth login' / check the URL)" >&2; return 1; }
}

# cb_bootstrap ROOT INTENT MODE FORCE [FLAVOR] — scaffold a project + write the brief.
#   MODE = full | brief   FORCE = 1 to overwrite an existing brief
#   FLAVOR = adopt (existing repo — skip greenfield scaffolding) | workspace (multi-repo
#            orchestration parent — git init + README but NO workloads/) | "" (greenfield).
# Does NOT boot claudebot or write a workspace CLAUDE.md (the entrypoint bakes that on first
# boot). An existing .git auto-implies `adopt` so we never pollute an existing repo.
cb_bootstrap() {
    local root="$1" intent="$2" mode="${3:-full}" force="${4:-}" flavor="${5:-}" brief _dot _dotname
    cb_preflight "$mode" || return 1
    brief="$(cb_brief_path "$root")"
    if [ -f "$brief" ] && [ -z "$force" ]; then
        echo "❌ $brief already exists — use --force to overwrite" >&2; return 1
    fi
    # an existing git repo means we're ADOPTING it, not greenfielding (unless workspace)
    [ -z "$flavor" ] && [ -e "$root/.git" ] && flavor=adopt
    _dot="$(cb_project_dot "$root")"; _dotname="$(basename "$_dot")"
    mkdir -p "$_dot"
    if [ "$mode" = "full" ]; then
        case "$flavor" in
            adopt) : ;;   # existing repo — deliberately no greenfield scaffolding
            workspace)
                [ -e "$root/.git" ] || { git -C "$root" init -q 2>/dev/null && echo "  ✓ git init (orchestration parent)"; }
                [ -f "$root/README.md" ] || { cb_write_readme "$root"; echo "  ✓ README.md"; } ;;
            *)  # greenfield
                git -C "$root" init -q 2>/dev/null && echo "  ✓ git init"
                [ -f "$root/README.md" ] || { cb_write_readme "$root"; echo "  ✓ README.md"; }
                mkdir -p "$root/workloads"
                [ -e "$root/workloads/.gitkeep" ] || : > "$root/workloads/.gitkeep" ;;
        esac
    fi
    cb_write_brief "$root" "$intent" "$flavor";    echo "  ✓ ${_dotname}/BRIEF.md (committed)"
    cb_init_project_config "$root" >/dev/null;     echo "  ✓ ${_dotname}/config.yml (gitignored)"
    case "$flavor" in
        adopt)     echo "🚀 adopted: $(basename "$root")" ;;
        workspace) echo "🚀 multi-repo workspace: $(basename "$root")" ;;
        *)         echo "🚀 bootstrapped: $(basename "$root")" ;;
    esac
}

# ─────────────────────────────────────────────────────────────────────────────
# 3.0 migration (#11, phase 4b) — move a 2.x install's on-disk state from the
# `claudebox` layout to the `dridock` layout.
#
# Three layers migrate independently, each idempotent:
#   1. workspace       .claudebox/{config,secrets,BRIEF,config.sample} → .dridock/
#                      + rewrite /.claudebox/... lines in .gitignore
#   2. per-project data dir       ~/.config/claudebox/projects/<id>/    → ~/.config/dridock/projects/<id>/
#   3. machine-wide config file   ~/.config/claudebox/config.yml         → ~/.config/dridock/config.yml
#
# The wrapper READS both layouts for one deprecation cycle (see cb_project_dot
# / cb_xdg_dir), so migration is safe to defer. `dridock migrate` runs (1)+(2)
# for the current project (and (3) once); `dridock migrate --all` also walks
# every data dir under the legacy claudebox/projects/. Auto-migrate on first
# `dridock` in a `.claudebox/`-only project does (1)+(2)+(3) silently unless
# DRIDOCK_NO_AUTO_MIGRATE=1.
# ─────────────────────────────────────────────────────────────────────────────

# cb_migrate_workspace ROOT — move ROOT/.claudebox/* → ROOT/.dridock/*, rewrite
# ROOT/.gitignore lines. Idempotent (no-op when there's nothing to migrate).
cb_migrate_workspace() {
    local root="$1" src dst f name tmp
    src="$root/.claudebox"; dst="$root/.dridock"
    [ -d "$src" ] || return 0
    mkdir -p "$dst"
    for f in "$src/config.yml" "$src/config.sample.yml" "$src/secrets.env" "$src/BRIEF.md"; do
        [ -e "$f" ] || continue
        name="$(basename "$f")"
        if [ -e "$dst/$name" ]; then
            echo "  ⚠ $(basename "$root")/.claudebox/$name: also exists in .dridock/ — leaving both, resolve by hand" >&2
            continue
        fi
        mv "$f" "$dst/$name"
        [ "$name" = "secrets.env" ] && chmod 600 "$dst/$name"
        echo "  ✓ .claudebox/$name → .dridock/$name"
    done
    if [ -f "$root/.gitignore" ]; then
        tmp="$(mktemp)"
        sed 's#^/\.claudebox/#/.dridock/#' "$root/.gitignore" > "$tmp" && cat "$tmp" > "$root/.gitignore"
        rm -f "$tmp"
    fi
    rmdir "$src" 2>/dev/null && echo "  ✓ removed empty .claudebox/"
    return 0
}

# cb_migrate_data_dir ID — move ~/.config/claudebox/projects/<id> → ~/.config/dridock/projects/<id>.
# Idempotent (no-op when the legacy dir isn't there). Skips if both exist.
cb_migrate_data_dir() {
    local id="$1" xdg new_root old_root
    [ -n "$id" ] || return 0
    xdg="$(cb_config_home)"
    new_root="$xdg/dridock/projects"
    old_root="$xdg/claudebox/projects"
    [ -d "$old_root/$id" ] || return 0
    if [ -e "$new_root/$id" ]; then
        echo "  ⚠ data dir $id: both claudebox/ and dridock/ have it — leaving both, resolve by hand" >&2
        return 1
    fi
    mkdir -p "$new_root"
    mv "$old_root/$id" "$new_root/$id"
    echo "  ✓ data dir $id: claudebox/projects/ → dridock/projects/"
    return 0
}

# cb_migrate_machine_config — move ~/.config/claudebox/config.yml → ~/.config/dridock/config.yml.
cb_migrate_machine_config() {
    local xdg old new
    xdg="$(cb_config_home)"
    old="$xdg/claudebox/config.yml"
    new="$xdg/dridock/config.yml"
    [ -f "$old" ] || return 0
    if [ -f "$new" ]; then
        echo "  ⚠ machine config: both claudebox/config.yml and dridock/config.yml exist — leaving both" >&2
        return 1
    fi
    mkdir -p "$xdg/dridock"
    mv "$old" "$new"
    echo "  ✓ machine config: claudebox/config.yml → dridock/config.yml"
    return 0
}

# cb_migrate_state_dirs — move the four cross-project state subdirs
# (cdp / consult / framework-bugs / host-agent) from ~/.config/claudebox/<name>
# to ~/.config/dridock/<name>. Idempotent per subdir. Only moves subdirs the
# 3.0 rebrand missed — the per-project data dir + machine config each have
# their own migrator above.
#
# #29 introduced the function; #32 (3.3.1) added two guards for cases the
# original happy-path implementation didn't consider:
#
#   Defect A — the `cdp/` subdir hosts a live Chrome debug profile the
#   browser-bridge is running against; `mv` on it renames inodes out from
#   under running Chrome, and the profile's SingletonLock / Preferences
#   encode absolute paths, so the next launch silently starts a fresh
#   profile OR errors. This function is called via `cb_auto_migrate`, so
#   the mv is opt-out, not opt-in — user runs any `dridock` on 3.2.4 with
#   the bridge up, live profile relocates. Guard: pgrep for Chrome using
#   the specific --user-data-dir=$old path; if found, SKIP the cdp move
#   with an actionable message.
#
#   Defect B — when BOTH `~/.config/{dridock,claudebox}/$name` exist, a
#   bare "leaving both" warning strand the legacy content: `_cb_state_home`
#   unconditionally prefers dridock/, so the legacy dir becomes unreachable
#   with no signal after the warning scrolls off. Guard: return non-zero
#   from this function when any split-brain hit occurred, and print a
#   persistent-visibility message pointing at the specific dir. The read
#   path in `_cb_state_home` also warns on every read while split — no
#   more "silent orphan" (see the same-file _cb_state_home changes).
cb_migrate_state_dirs() {
    local xdg name old new split=0
    xdg="$(cb_config_home)"
    for name in cdp consult framework-bugs host-agent; do
        old="$xdg/claudebox/$name"
        new="$xdg/dridock/$name"
        [ -d "$old" ] || continue

        # Defect A guard — live-Chrome check for the cdp profile ONLY.
        # `pgrep -f` on macOS + Linux matches the FULL command line; Chrome
        # runs with an absolute --user-data-dir, so an exact prefix match
        # against $old is precise (no false positive from paths that merely
        # contain the string). Skip means the legacy path stays readable —
        # `_cb_state_home` falls back — so the browser bridge keeps working
        # until the user closes Chrome and runs `dridock migrate` explicitly.
        if [ "$name" = cdp ] && pgrep -f -- "--user-data-dir=$old" >/dev/null 2>&1; then
            echo "  ⚠ state dir cdp: SKIPPING — Chrome is running against $old" >&2
            echo "     Close it (or run 'dridock browser-bridge down'), then 'dridock migrate' again." >&2
            echo "     The bridge keeps working from the legacy path until then." >&2
            # #32 f/u — data-safety was correct (skip preserves the profile) but
            # 3.3.1 forgot to signal the skip via the same channel split-brain
            # uses, so `dridock migrate` reported `✅ done.` when cdp was silently
            # left behind. Set split=1 so the verb takes the `⚠ done, resolve
            # and re-run` branch — same silent-success class the whole guard is
            # here to prevent, one level up.
            split=1
            continue
        fi

        if [ -e "$new" ]; then
            # Defect B — merge, don't orphan. Non-colliding entries in the legacy
            # dir move to dridock/. Colliding entries get a `.legacy-<ts>` suffix
            # so both copies stay reachable and the user can pick. Split=1 only
            # when a real collision happened (needs human attention); a clean
            # merge is a full success. cdp is intentionally excluded — its content
            # is a Chrome profile (thousands of interdependent files) that does
            # not merge safely.
            if [ "$name" = cdp ]; then
                echo "  ⚠ state dir cdp: SPLIT — both roots exist. Cannot auto-merge a Chrome profile safely." >&2
                echo "     'dridock browser-bridge down', close Chrome, then keep whichever profile you want and delete the other." >&2
                split=1
                continue
            fi
            local _merged=0 _collided=0 _suffix _entry _base
            _suffix=".legacy-$(date +%Y%m%d%H%M%S)"
            shopt -s nullglob dotglob
            for _entry in "$old"/*; do
                _base="$(basename "$_entry")"
                if [ ! -e "$new/$_base" ]; then
                    mv "$_entry" "$new/$_base"
                    _merged=$((_merged + 1))
                else
                    mv "$_entry" "$new/${_base}${_suffix}"
                    echo "     collision: $name/$_base kept as $name/${_base}${_suffix} — pick one and delete the other" >&2
                    _collided=$((_collided + 1))
                fi
            done
            shopt -u nullglob dotglob
            rmdir "$old" 2>/dev/null || true
            if [ "$_collided" -gt 0 ]; then
                echo "  ⚠ state dir $name: SPLIT-BRAIN merged — $_merged clean, $_collided collision(s) kept side-by-side." >&2
                split=1
            else
                echo "  ✓ state dir: claudebox/$name → dridock/$name (merged $_merged entries into existing dridock/$name)"
            fi
            continue
        fi
        mkdir -p "$xdg/dridock"
        mv "$old" "$new"
        echo "  ✓ state dir: claudebox/$name → dridock/$name"
    done
    # remove the now-empty legacy root if it's empty (cheap, silent on failure)
    rmdir "$xdg/claudebox" 2>/dev/null || true
    # Return non-zero on any split-brain so callers (cb_auto_migrate + the
    # explicit `migrate` verb) can surface a persistent notice rather than
    # ship a one-time stderr scroll. Callers may ignore rc if they don't care.
    return "$split"
}

# cb_auto_migrate ROOT — silently migrate a legacy `.claudebox/`-only workspace on
# first `dridock` run. Opt out with DRIDOCK_NO_AUTO_MIGRATE=1. No-op when the
# project is already on `.dridock/`, or when the wrapper is running a management
# subcommand (the caller decides — this only checks its own preconditions).
cb_auto_migrate() {
    local root="$1" id
    case "${DRIDOCK_NO_AUTO_MIGRATE:-}" in 1|true|yes|on) return 0 ;; esac
    [ -d "$root/.claudebox" ] || return 0
    [ -d "$root/.dridock" ] && return 0
    echo "🔀 dridock 3.0: migrating .claudebox/ → .dridock/  (opt out: DRIDOCK_NO_AUTO_MIGRATE=1)"
    cb_migrate_workspace "$root"
    id="$(cb_project_id_ro "$root")"
    [ -n "$id" ] && cb_migrate_data_dir "$id"
    cb_migrate_machine_config
    cb_migrate_state_dirs
}

# load functions only (for tests) without running the wrapper body
[ -n "${DRIDOCK_SOURCE_ONLY:-}" ] && return 0 2>/dev/null || true

DEBUG="${DRIDOCK_ENV_DEBUG:-${CLAUDEBOX_ENV_DEBUG:-${DEBUG:-}}}"

dbg() { [ "${DEBUG:-}" = "true" ] && echo "[DEBUG $(date +%H:%M:%S.%3N)] $*" >&2; }

# Keep the Mac awake for the duration of a FOREGROUND claudebox run, so a long claudebot
# session (or a build the VM is doing) doesn't stall when the machine idles to sleep and
# Colima suspends. Opt-in via DRIDOCK_CAFFEINATE=1; macOS-only; self-cleaning — the
# `-w $$` ties it to THIS wrapper process, so it exits when your session ends. `-dimsu`:
# no display/idle/disk/system sleep, assert user active. (System sleep is only fully
# held on AC power — a macOS limitation.) Idempotent within one invocation.
_cb_caffeinated=
cb_caffeinate() {
    [ -n "$_cb_caffeinated" ] && return 0
    case "${DRIDOCK_CAFFEINATE:-${CLAUDE_CAFFEINATE:-}}" in ''|0|false|no) return 0 ;; esac
    command -v caffeinate >/dev/null 2>&1 || { dbg "caffeinate requested but not found (not macOS?)"; return 0; }
    caffeinate -dimsu -w "$$" >/dev/null 2>&1 &
    _cb_caffeinated=1
    dbg "caffeinate: holding the Mac awake until this claudebox exits (wrapper pid $$)"
}

# This fork uses a locally-built image (see install.sh / `make build`), NOT the
# upstream psyb0t/claudebox on Docker Hub. The bare repo name has no registry
# prefix, so Docker never tries to pull it — a missing image is a hard error,
# which is what we want (build it locally first). Override with DRIDOCK_IMAGE.
CLAUDE_IMAGE="${DRIDOCK_IMAGE:-${CLAUDE_IMAGE:-}}"
CLAUDE_IMAGE_NAME="${DRIDOCK_IMAGE_NAME:-dridock}"
_minimal="${DRIDOCK_MINIMAL:-${CLAUDE_MINIMAL:-}}"
if [ -z "$CLAUDE_IMAGE" ]; then
    if [ -n "$_minimal" ]; then
        CLAUDE_IMAGE="${CLAUDE_IMAGE_NAME}:latest-minimal"
    else
        CLAUDE_IMAGE="${CLAUDE_IMAGE_NAME}:latest"
    fi
fi

CLAUDE_GIT_NAME="${DRIDOCK_GIT_NAME:-${CLAUDE_GIT_NAME:-}}"
CLAUDE_GIT_EMAIL="${DRIDOCK_GIT_EMAIL:-${CLAUDE_GIT_EMAIL:-}}"
# Fall back to the HOST's own git identity so a fresh claudebot can commit without the
# human pre-setting DRIDOCK_GIT_* (or legacy CLAUDEBOX_GIT_*). Without an identity, git
# dies on the first commit with "Author identity unknown". Explicit DRIDOCK_GIT_* still
# wins; the entrypoint
# writes these to the container's ~/.gitconfig, which persists across restarts.
[ -n "$CLAUDE_GIT_NAME" ]  || CLAUDE_GIT_NAME="$(git config --global --get user.name 2>/dev/null || true)"
[ -n "$CLAUDE_GIT_EMAIL" ] || CLAUDE_GIT_EMAIL="$(git config --global --get user.email 2>/dev/null || true)"
# Per-project shared-nothing data dir (Phase 3 of docs/design/per-project-vm.md).
# An explicit DRIDOCK_DATA_DIR / CLAUDE_DATA_DIR override still wins; otherwise
# CLAUDE_DIR is resolved per project after the VM subcommands (needs the id).
CLAUDE_DIR="${DRIDOCK_DATA_DIR:-${CLAUDE_DATA_DIR:-}}"
CLAUDE_SSH="${DRIDOCK_SSH_DIR:-${CLAUDE_SSH_DIR:-$HOME/.ssh/claudebox}}"

# auth: prefer DRIDOCK_ENV_* (or legacy CLAUDEBOX_ENV_*), fall back to direct env vars
ANTHROPIC_API_KEY="${DRIDOCK_ENV_ANTHROPIC_API_KEY:-${CLAUDEBOX_ENV_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}}"
CLAUDE_CODE_OAUTH_TOKEN="${DRIDOCK_ENV_CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDEBOX_ENV_CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDE_CODE_OAUTH_TOKEN:-}}}"
# DRIDOCK_NO_API_KEY=1 → never send an ANTHROPIC_API_KEY into the container, even if one
# is exported on the Mac. Use the Claude subscription (browser OAuth / a setup-token) instead.
# The empty value flows to the auth sidecar, and the entrypoint UNSETS the var so a
# previously-created container's stale key is cleared too.
case "${DRIDOCK_NO_API_KEY:-${CLAUDE_NO_API_KEY:-}}" in
    1|true|yes|on) ANTHROPIC_API_KEY="" ;;
esac
# DRIDOCK_NO_OAUTH_TOKEN=1 → mirror above but for the model-scope setup-token. Set when
# a user has done `claude auth login` inside the container (full-scope OAuth) and needs
# the stored credentials to take effect for Remote Control — otherwise the env var from
# `dridock setup-token` overrides the full login and RC stays inactive. Same mechanism:
# empty value flows to the sidecar, entrypoint UNSETS the stale env. See #16.
case "${DRIDOCK_NO_OAUTH_TOKEN:-${CLAUDE_NO_OAUTH_TOKEN:-}}" in
    1|true|yes|on) CLAUDE_CODE_OAUTH_TOKEN="" ;;
esac

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
container_name="${DRIDOCK_CONTAINER_NAME:-${CLAUDE_CONTAINER_NAME:-claude-${sanitized_pwd}}}"
dbg "container_name=$container_name"
dbg "CLAUDE_DIR=$CLAUDE_DIR"
dbg "CLAUDE_SSH=$CLAUDE_SSH"
dbg "PWD=$PWD"

# ── per-project VM subcommands (Phase 2 of docs/design/per-project-vm.md) ─────
# Act on the project's colima VM and exit before any container/auth setup.
CB_PROJECT_ROOT="$(cb_project_root "$PWD")"
dbg "CB_PROJECT_ROOT=$CB_PROJECT_ROOT"
case "${1:-}" in
    "")
        # Bare `dridock` (no args) prints version + hint. Explicit `dridock start`
        # is now required to launch the claudebot (#12, 2.24.0). Rationale: reduces
        # accidental container starts from muscle-typing `dridock` in the wrong dir,
        # and matches the reflex-inspection habit for most CLIs (bare = info).
        printf 'dridock %s\n' "$DRIDOCK_VERSION"
        printf '\n'
        printf '  dridock start                start/attach the claudebot for $PWD\n'
        printf '  dridock start -p "<prompt>"  one-shot programmatic run\n'
        printf '  dridock --help               full help\n'
        exit 0
        ;;
    start)
        # #12 (2.24.0): explicit launch verb. Shift `start` off and fall through to
        # the guards + container-run path below — the rest of the script is unchanged.
        shift
        ;;
    -h|--help|help)
        cat <<HELP
dridock $DRIDOCK_VERSION — run Claude Code in a per-project Colima VM.
             (renamed from 'claudebox' in 3.0; 'CLAUDEBOX_*' env vars still accepted.)

USAGE
  dridock start [claude args...]  start/attach the interactive claudebot for \$PWD
  dridock start -p "<prompt>" ... one-shot programmatic run (JSON via --output-format)
  dridock <command>               a management command (below)
  dridock                         print version + start hint
  dridock completion bash         emit a bash completion script (installed by install.sh)

PROJECT
  bootstrap [--seed-secret KEY=CMD] [...]  scaffold a project + mission brief (see --help on it)
  info | status                    at-a-glance: versions, paths, VM, network
  features [list|enable|disable|info <n>]  3.0 (#5): manage this project's opt-in bundles
                                   ('profiles' is a legacy alias for one deprecation cycle)
  ip                               the project VM's reachable IP + how to browse
  net [<hostname>]                 same as ip; with a name, sets network.hostname + prints
                                   the /etc/hosts line so you can browse http://<name>:<port>
  stop                             stop the claudebot container (keep the VM)
  clear-session                    forget the resumable session for \$PWD

VM / DISK
  vm ls                            list this fork's project VMs
  vm usage                         per-VM disk footprint (+ orphaned disks)
  vm gc                            reclaim disk: prune orphaned disks + old images + fstrim VMs
  down                             stop the project VM (keep its disk)
  destroy [--purge]                delete the VM (+ --purge: also its session/data dir)

VERSION
  version                          print this wrapper's semver
  checkversion [--all]             compare wrapper vs image; warn on drift (must/should/optional). --all = every cb-* project VM

OTHER
  migrate [--all]                  3.0: move .claudebox/ → .dridock/ (workspace + data dir + machine config); --all sweeps every legacy data dir
  completion bash                  emit a bash completion script (installed by install.sh)
  browser-bridge up|down           opt-in: let claudebot drive your real Chrome via CDP
  host-agent up|down|status        opt-in (TRUSTED): let a HARNESS-DEV claudebot run allowlisted colima/limactl on the Mac
  harness <verb>                   framework-dev: harness-dev-only ops. Verbs: sync [--repair] (rebuild cb-infra; --repair auto-prunes on BuildKit corruption)
  framework-bugs [list|clear]      review bugs claudebot filed with cb-report-bug
  consult list|show|approve|watch  supervised claudebot<->framework-Claude threads (watch=block-until-change)
  setup-token                      run 'claude setup-token' in a throwaway container
  -v | --version | doctor | auth | mcp    passthrough to the claude CLI

USEFUL ENV
  DRIDOCK_CAFFEINATE=1          keep the Mac awake during a foreground session (macOS)
  DRIDOCK_MINIMAL=1             use the minimal image variant
  DRIDOCK_NO_API_KEY=1          never forward ANTHROPIC_API_KEY — use Claude subscription (setup-token) instead of API billing
  DRIDOCK_NO_OAUTH_TOKEN=1      never forward CLAUDE_CODE_OAUTH_TOKEN — needed for --remote-control (use 'claude auth login' inside the container first; see #16)
  DRIDOCK_ALLOW_NEW=1           skip the "create a new project here?" prompt (or the non-interactive abort)
  DRIDOCK_HARNESS_DEV=1         force framework-dev mode (auto-detected when the workspace is a dridock harness fork, including the legacy claudebox one). Alias: DRIDOCK_FRAMEWORK_DEV.
  DRIDOCK_NO_DRIFT_WARN=1       silence the "cb-infra image is behind wrapper" warning on each dridock invocation
  DRIDOCK_NO_AUTO_MIGRATE=1     skip the 3.0 auto-migration of a legacy .claudebox/ workspace on first run (run 'dridock migrate' by hand)
  DRIDOCK_ENV_FOO=bar             forward FOO=bar (legacy CLAUDEBOX_ENV_FOO accepted) into the container
  DRIDOCK_PRUNE_ON_START=1      docker builder prune (cache) + image prune (dangling) on each start
  DRIDOCK_TMPFS_TMP=2g          RAM-back /tmp so docker bloat can't ENOSPC-kill the Bash tool
  DEBUG / DRIDOCK_ENV_DEBUG       verbose wrapper logging (legacy CLAUDEBOX_ENV_DEBUG accepted)
  See docs/environment-variables.md for the full list; docs/versioning.md for releases.
HELP
        exit 0
        ;;
    vm)
        case "${2:-}" in
            ls|list|"")  cb_vm_ls; exit 0 ;;
            usage|df)    cb_vm_usage; exit $? ;;
            gc)          cb_vm_gc; exit $? ;;
            *) echo "usage: dridock vm [ls|usage|gc]" >&2; exit 1 ;;
        esac
        ;;
    version)
        # the host wrapper's own semver (cheap; no docker). See also: checkversion.
        printf 'dridock %s\n' "$DRIDOCK_VERSION"; exit 0
        ;;
    completion)
        # #13 (2.24.0): emit a shell completion script. Bash for now — zsh users with
        # `bashcompinit` loaded pick this up too; a native zsh completion is separate.
        # install.sh runs `claudebox completion bash` and drops the output into
        # ~/.local/share/bash-completion/completions/<binname> (XDG standard).
        case "${2:-}" in
            bash) cb_completion_bash; exit 0 ;;
            "")   echo "usage: $(basename "$0") completion bash" >&2; exit 1 ;;
            *)    echo "$(basename "$0") completion: unsupported shell '$2' (bash only for now)" >&2; exit 1 ;;
        esac
        ;;
    checkversion)
        # host wrapper vs claudebot image semver + drift warning (read-only).
        # `--all` scans every cb-* project VM (2.23.0, #6).
        shift; cb_checkversion "$@"; exit $?
        ;;
    info|status)
        # human-facing at-a-glance: versions, paths, VM + network (read-only, fast).
        cb_info "$CB_PROJECT_ROOT"; exit $?
        ;;
    features)
        # 3.0 (#5): list | enable <name> | disable <name> | info <name>. Manages
        # the .dridock/config.yml `features:` block + the per-project enable markers.
        shift; cb_features_cmd "$CB_PROJECT_ROOT" "$@"; exit $?
        ;;
    profiles)
        # legacy alias for `features` (one deprecation cycle; removed in 4.0). Prints
        # a one-line deprecation notice, then dispatches to the same handler.
        shift; cb_profiles_cmd "$CB_PROJECT_ROOT" "$@"; exit $?
        ;;
    migrate)
        # 3.0 migration (#11 phase 4b). No-arg: migrate THIS project's workspace + data dir
        # (+ the machine config, once). --all: also walk every legacy data dir under
        # ~/.config/claudebox/projects/. Auto-migrate handles the common case; this verb is
        # for a supervised migration or a bulk cleanup after upgrading multiple projects.
        shift
        _mig_all=0
        while [ $# -gt 0 ]; do
            case "$1" in
                --all) _mig_all=1 ;;
                -h|--help)
                    echo "usage: dridock migrate [--all]"
                    echo "  migrate this project's .claudebox/ → .dridock/ (workspace + its data dir),"
                    echo "  plus the machine config (~/.config/claudebox/config.yml) and the four"
                    echo "  cross-project state dirs (cdp, consult, framework-bugs, host-agent)."
                    echo "  --all also migrates every legacy project data dir under"
                    echo "        ~/.config/claudebox/projects/ (workspace paths are unknown to the"
                    echo "        wrapper — those migrate on their next 'dridock' auto-migrate)."
                    echo "  auto-migrate fires on the first 'dridock' in a .claudebox/-only project;"
                    echo "  disable with DRIDOCK_NO_AUTO_MIGRATE=1."
                    exit 0 ;;
                *) echo "migrate: unknown arg '$1' (try --help)" >&2; exit 1 ;;
            esac
            shift
        done
        echo "migrate: $CB_PROJECT_ROOT"
        cb_migrate_workspace "$CB_PROJECT_ROOT"
        _mig_id="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
        [ -n "$_mig_id" ] && cb_migrate_data_dir "$_mig_id"
        cb_migrate_machine_config
        # #32 — cb_migrate_state_dirs returns non-zero when it skipped a subdir
        # (live-Chrome guard OR split-brain). Surface the skip in the final line
        # rather than printing "✅ done" over a stderr scroll the user missed.
        _mig_state_rc=0; cb_migrate_state_dirs || _mig_state_rc=$?
        if [ "$_mig_all" = 1 ]; then
            echo "migrate --all: sweeping legacy project data dirs…"
            _mig_old_root="$(cb_config_home)/claudebox/projects"
            if [ -d "$_mig_old_root" ]; then
                for _mig_pd in "$_mig_old_root"/*; do
                    [ -d "$_mig_pd" ] || continue
                    cb_migrate_data_dir "$(basename "$_mig_pd")"
                done
                # remove the now-empty legacy root if it's empty (cheap, silent on failure)
                rmdir "$_mig_old_root" 2>/dev/null && rmdir "$(dirname "$_mig_old_root")" 2>/dev/null || true
            else
                echo "  (no legacy claudebox/projects/ dir — nothing to sweep)"
            fi
        fi
        if [ "${_mig_state_rc:-0}" -ne 0 ]; then
            echo "⚠  done — but one or more state dirs were skipped (see warnings above). Resolve and re-run 'dridock migrate'."
        else
            echo "✅ done."
        fi
        # #32 f/u2 — the exit code has to match the message: automation like
        # `dridock migrate || alert` (setup scripts, Makefile targets) needs the
        # verb to signal failure when it half-succeeded. Same silent-drop family
        # that the whole 3.3.x series has been draining — the ⚠ line without a
        # matching rc was the one caller class the 3.3.1/3.3.2 signals still lied to.
        exit "${_mig_state_rc:-0}"
        ;;
    down)
        _cbid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
        if [ -z "$_cbid" ]; then echo "no dridock VM for this project (no .dridock/config.yml or legacy .claudebox/config.yml)"; exit 0; fi
        cb_vm_down "$_cbid"; exit $?
        ;;
    destroy)
        _purge=
        case "${2:-}" in
            --purge|--purge-data) _purge=1 ;;
            "") : ;;
            *) echo "usage: $CB_SELF destroy [--purge]   (--purge also deletes this project's session/data dir)" >&2; exit 1 ;;
        esac
        _cbid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
        if [ -z "$_cbid" ]; then echo "no dridock project here (.dridock/config.yml missing)"; exit 0; fi
        cb_vm_destroy "$_cbid" || exit $?
        [ -n "$_purge" ] && cb_purge_data "$_cbid"
        exit 0
        ;;
    browser-bridge)
        _cbid="$(cb_project_id "$CB_PROJECT_ROOT")"
        case "${2:-}" in
            up)   cb_bridge_up "$_cbid"; exit $? ;;
            down) cb_bridge_down "$_cbid"; exit $? ;;
            *)    echo "usage: $CB_SELF browser-bridge up|down  (opt-in: let claudebot drive your real Chrome via CDP)" >&2; exit 1 ;;
        esac
        ;;
    host-agent)
        # Approach 2: proxy colima/limactl from a harness-dev claudebot to the Mac.
        case "${2:-status}" in
            up)     cb_host_agent_up; exit $? ;;
            down)   cb_host_agent_down; exit $? ;;
            status) cb_host_agent_status; exit $? ;;
            *)      echo "usage: $CB_SELF host-agent up|down|status  (opt-in: let a HARNESS-DEV claudebot run allowlisted colima/limactl on your Mac — trusted use only; see docs/design/backends.md)" >&2; exit 1 ;;
        esac
        ;;
    harness)
        # framework-dev-only ops (gated by cb_is_framework_dev). Namespace so more
        # dev-only verbs can accrete without cluttering the top-level command list.
        _harness_verb="${2:-}"
        shift 2 2>/dev/null || shift $# 2>/dev/null || true   # drop `harness` + verb; $@ = flags for the verb
        case "$_harness_verb" in
            sync) cb_harness_sync "$@"; exit $? ;;
            "")   echo "usage: $CB_SELF harness <verb>  (framework-dev only; verbs: sync [--repair])" >&2; exit 1 ;;
            *)    echo "$CB_SELF harness: unknown verb '$_harness_verb'  (verbs: sync)" >&2; exit 1 ;;
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
                    echo ""; echo "view one:  cat \"$_fwb\"/<file>     clear all:  $CB_SELF framework-bugs clear"
                fi ;;
            clear) rm -f "$_fwb"/*.md 2>/dev/null; echo "cleared framework bug reports in $_fwb" ;;
            *)     echo "usage: $CB_SELF framework-bugs [list|clear]" >&2; exit 1 ;;
        esac
        exit 0
        ;;
    consult)
        # Supervised claudebot<->framework-Claude threads. See docs/design/framework-consult.md.
        # YOU are the approval gate; framework-Claude drafts (via the framework-consult skill).
        _ch="$(cb_consult_home)"; mkdir -p "$_ch" 2>/dev/null || true
        _cid="${3:-}"
        case "${2:-list}" in
            list)
                shopt -s nullglob; _threads=("$_ch"/*/); shopt -u nullglob
                if [ "${#_threads[@]}" -eq 0 ]; then echo "no consults in $_ch"; else
                    echo "consults (${#_threads[@]}) in $_ch:"
                    for _t in "${_threads[@]}"; do
                        _t="${_t%/}"; _id="$(basename "$_t")"
                        printf '  %-28s [%s]  %s\n' "$_id" "$(cb_consult_status "$_t")" "$(sed -n 's/^title=//p' "$_t/meta" | head -1)"
                    done
                    echo ""; echo "show:  $CB_SELF consult show <id>     approve/revise/reject: $CB_SELF consult <verb> <id>"
                fi ;;
            show)
                [ -n "$_cid" ] || { echo "usage: $CB_SELF consult show <id>" >&2; exit 1; }
                _t="$_ch/$_cid"; [ -d "$_t" ] || { echo "no such consult: $_cid" >&2; exit 1; }
                echo "=== consult $_cid ==="; cat "$_t/meta"; echo ""
                for _m in "$_t"/[0-9][0-9][0-9]-*.md; do [ -f "$_m" ] || continue; echo "── $(basename "$_m") ──"; cat "$_m"; echo ""; done
                [ -f "$_t/proposed.diff" ] && { echo "── proposed.diff ──"; cat "$_t/proposed.diff"; } ;;
            approve)
                [ -n "$_cid" ] || { echo "usage: $CB_SELF consult approve <id>" >&2; exit 1; }
                _t="$_ch/$_cid"; [ -d "$_t" ] || { echo "no such consult: $_cid" >&2; exit 1; }
                [ "$(cb_consult_status "$_t")" = "awaiting-approval" ] || echo "note: status is '$(cb_consult_status "$_t")' (expected awaiting-approval)" >&2
                cb_consult_meta_set "$_t" status awaiting-claudebot
                printf 'Approved by the human. Framework-Claude: apply the proposed change, commit, and post the reply with the commit hash.\n' | cb_consult_post "$_t" human
                echo "✅ approved $_cid — framework-Claude will now apply + reply." ;;
            revise)
                [ -n "$_cid" ] || { echo "usage: $CB_SELF consult revise <id> [note]" >&2; exit 1; }
                _t="$_ch/$_cid"; [ -d "$_t" ] || { echo "no such consult: $_cid" >&2; exit 1; }
                cb_consult_meta_set "$_t" status awaiting-framework
                _note="${*:4}"; [ -n "$_note" ] || _note="please revise the draft"
                printf '%s\n' "$_note" | cb_consult_post "$_t" human
                echo "↩️  bounced $_cid back for revision." ;;
            reject)
                [ -n "$_cid" ] || { echo "usage: $CB_SELF consult reject <id> [reason]" >&2; exit 1; }
                _t="$_ch/$_cid"; [ -d "$_t" ] || { echo "no such consult: $_cid" >&2; exit 1; }
                cb_consult_meta_set "$_t" status rejected
                _note="${*:4}"; [ -n "$_note" ] || _note="rejected"
                printf '%s\n' "$_note" | cb_consult_post "$_t" human
                echo "🚫 rejected $_cid." ;;
            post)
                # low-level append used by framework-Claude (the skill) and you:
                #   claudebox consult post <id> --author framework --status awaiting-approval [--diff F] < body
                [ -n "$_cid" ] || { echo "usage: $CB_SELF consult post <id> [--author A] [--status S] [--diff F] < body" >&2; exit 1; }
                _t="$_ch/$_cid"; mkdir -p "$_t"
                _author=framework; _status=""; _diff=""
                shift 3 2>/dev/null || true
                while [ $# -gt 0 ]; do case "$1" in
                    --author) _author="${2:-framework}"; shift ;;
                    --status) _status="${2:-}"; shift ;;
                    --diff)   _diff="${2:-}"; shift ;;
                    *) : ;;
                esac; shift; done
                cb_consult_post "$_t" "$_author"
                [ -n "$_diff" ] && [ -f "$_diff" ] && cp "$_diff" "$_t/proposed.diff"
                [ -n "$_status" ] && cb_consult_meta_set "$_t" status "$_status"
                echo "posted $_author turn to $_cid${_status:+ (status=$_status)}" ;;
            watch)
                # Block (token-free) until a consult needs FRAMEWORK action, print it, exit.
                # Run as a BACKGROUND task in a live framework-Claude session: the harness
                # re-invokes the session on exit; handle it, relaunch. Only wakes on a thread
                # ENTERING awaiting-framework (a new consult, or a claudebot say/revise) or
                # gaining a turn while there — NOT on the awaiting-approval/awaiting-claudebot
                # states framework-Claude sets itself (else posting a draft self-triggers it).
                _iv="${3:-20}"; case "$_iv" in ''|*[!0-9]*) _iv=20 ;; esac
                _act() { cb_consult_sig "$_ch" | awk -F'|' '$2=="awaiting-framework"{print $1"|"$3}' | sort; }
                _base="$(_act)"
                echo "👁  watching $_ch for consults needing a framework draft (every ${_iv}s; Ctrl-C to stop)…" >&2
                while :; do
                    sleep "$_iv"
                    _cur="$(_act)"
                    _new="$(comm -13 <(printf '%s\n' "$_base") <(printf '%s\n' "$_cur"))"
                    if [ -n "$_new" ]; then
                        echo "🗣  consult(s) awaiting a framework draft:"
                        printf '%s\n' "$_new" | while IFS='|' read -r _id _n; do
                            [ -n "$_id" ] && printf '  %-28s  (%s consult show %s)\n' "$_id" "$CB_SELF" "$_id"
                        done
                        exit 0
                    fi
                    _base="$_cur"   # absorb removals / framework's own posts silently
                done ;;
            *) echo "usage: $CB_SELF consult list|show|approve|revise|reject|post|watch <id>" >&2; exit 1 ;;
        esac
        exit 0
        ;;
    claude-dir)
        # print the host .claude data dir for THIS project (read-only; no config init,
        # no VM). Authoritative — respects a DRIDOCK_DATA_DIR override and the
        # machine data_root. Used by the cbx-claude-dir shell helper.
        _dd="${DRIDOCK_DATA_DIR:-${CLAUDE_DATA_DIR:-}}"
        if [ -n "$_dd" ]; then
            printf '%s\n' "$_dd"
        else
            _cbid="$(cb_project_id_ro "$CB_PROJECT_ROOT")"
            [ -n "$_cbid" ] || { echo "no dridock project here (.dridock/config.yml missing)" >&2; exit 1; }
            printf '%s\n' "$(cb_project_data_dir "$_cbid")"
        fi
        exit 0
        ;;
    bootstrap)
        # scaffold a new claudebot project in $PWD + write the mission brief.
        shift
        _bs_mode=full _bs_force= _bs_start=1 _bs_intent= _bs_file= _bs_secfile= _bs_ghtoken= _bs_adopt= _bs_adopt_url= _bs_workspace= ; _bs_repos=() _bs_seed=()
        while [ $# -gt 0 ]; do
            case "$1" in
                --brief-only) _bs_mode=brief; _bs_start= ;;
                --no-start)   _bs_start= ;;
                --force)      _bs_force=1 ;;
                --brief-file) _bs_file="${2:-}"; shift ;;
                --secrets-file) _bs_secfile="${2:-}"; shift ;;
                --seed-secret) # provider-agnostic: KEY=CMD; runs CMD on the host, stores stdout as KEY.
                               # Repeatable. Never accepts a raw secret value on the command line.
                               [ -n "${2:-}" ] || { echo "bootstrap: --seed-secret needs KEY=CMD" >&2; exit 1; }
                               case "$2" in *=*) _bs_seed+=("$2") ;;
                                            *) echo "bootstrap: --seed-secret expects KEY=CMD, got '$2'" >&2; exit 1 ;; esac
                               shift ;;
                --gh-token)   # deprecated alias for --seed-secret GH_TOKEN='gh auth token'. Removed in 4.0.
                              _bs_ghtoken=1
                              _bs_seed+=("GH_TOKEN=gh auth token") ;;
                --adopt)      # adopt an EXISTING repo (skip greenfield scaffolding). Optional
                              # next arg = a repo ref to clone into $PWD first (clone-then-adopt).
                              _bs_adopt=1
                              case "${2:-}" in
                                  ''|-*) : ;;
                                  *://*|git@*|*.git|*/*) _bs_adopt_url="$2"; shift ;;
                                  *) : ;;
                              esac ;;
                --workspace|--multi-repo) _bs_workspace=1 ;;   # multi-repo orchestration parent
                --repo)       _bs_workspace=1; [ -n "${2:-}" ] && { _bs_repos+=("$2"); shift; } ;;  # clone a sibling repo
                -h|--help)
                    echo "usage: dridock bootstrap [--adopt [<url>]] [--brief-only] [--no-start] [--force]"
                    echo "                           [--brief-file F] [--secrets-file F] [--seed-secret KEY=CMD]... [\"intent…\"]"
                    echo "  scaffold a claudebot project in the current directory + write .dridock/BRIEF.md."
                    echo "  intent comes from the arg, --brief-file, or stdin. Default boots claudebot after."
                    echo ""
                    echo "  existing repos (avoids the nested-repo tangle):"
                    echo "    --adopt           adopt the git repo already in this dir (skips greenfield scaffolding)"
                    echo "    --adopt <url>     clone <url> (URL or gh owner/repo) INTO this empty dir first, then adopt"
                    echo "                      — the repo becomes the workspace root; run it in a fresh empty dir."
                    echo ""
                    echo "  multi-repo (one project/VM, N repos as siblings):"
                    echo "    --workspace       make this dir an orchestration parent (git init, NO workloads/)"
                    echo "    --repo <url>       clone <url> as a gitignored sibling (repeatable; implies --workspace)"
                    echo "                      — parent gitignores the siblings so it never tracks them as gitlinks."
                    echo ""
                    echo "  secrets (never typed on the command line — file-based only):"
                    echo "    --secrets-file F        merge KEY=VALUE lines from F into .dridock/secrets.env"
                    echo "    --seed-secret KEY=CMD   run CMD on the host and store stdout as KEY (repeatable)"
                    echo "                            e.g. --seed-secret GH_TOKEN='gh auth token'"
                    echo "                                 --seed-secret GITLAB_TOKEN='glab auth token'"
                    echo "    --gh-token              deprecated alias for --seed-secret GH_TOKEN='gh auth token'"
                    echo "  secrets.env is gitignored + chmod 600 and injected into claudebot as env each run."
                    echo "  API-only tokens (per-provider). For git ops, add ~/.ssh/claudebox/id_ed25519.pub"
                    echo "  to each git host you push to (SSH is the provider-agnostic path — see"
                    echo "  docs/design/git-and-api-auth.md)."
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
        # flavor: adopt (one existing repo IS the workspace) XOR workspace (a parent holding
        # N sibling repos). Mutually exclusive.
        if [ -n "$_bs_adopt" ] && [ -n "$_bs_workspace" ]; then
            echo "❌ bootstrap: --adopt and --workspace are mutually exclusive." >&2; exit 1
        fi
        _bs_flavor=; [ -n "$_bs_adopt" ] && _bs_flavor=adopt; [ -n "$_bs_workspace" ] && _bs_flavor=workspace
        # --adopt: clone-then-adopt, or adopt the repo already in $PWD.
        if [ -n "$_bs_adopt_url" ]; then
            cb_clone_adopt "$_bs_adopt_url" || exit 1
            echo "  ✓ cloned $(basename "$_bs_adopt_url" .git) (repo IS the workspace root)"
        elif [ -n "$_bs_adopt" ] && [ ! -e "$PWD/.git" ]; then
            echo "❌ bootstrap --adopt: no git repo in $PWD to adopt. Use --adopt <url> to clone one here, or run plain 'bootstrap' for a greenfield project." >&2; exit 1
        fi
        cb_bootstrap "$PWD" "$_bs_intent" "$_bs_mode" "$_bs_force" "$_bs_flavor" || exit $?
        # --workspace: gitignore the machine-local files, then clone each --repo as a
        # GITIGNORED sibling so the parent orchestration repo never tracks it as a gitlink.
        if [ -n "$_bs_workspace" ]; then
            for _ig in '/.dridock/config.yml' '/.dridock/secrets.env'; do
                grep -qxF "$_ig" "$PWD/.gitignore" 2>/dev/null || echo "$_ig" >> "$PWD/.gitignore"
            done
            if [ "${#_bs_repos[@]}" -gt 0 ]; then
                for _url in "${_bs_repos[@]}"; do
                    _name="$(basename "$_url" .git)"
                    if [ -e "$PWD/$_name" ]; then
                        echo "  ⚠ $_name/ already exists — skipping clone" >&2
                    else
                        echo "  ⬇ cloning $_url → $_name/ …"
                        if command -v gh >/dev/null 2>&1 && gh repo clone "$_url" "$_name" >/dev/null 2>&1; then :
                        elif git clone -q "$_url" "$_name" 2>/dev/null; then :
                        else echo "  ❌ clone failed: $_url (private? check 'gh auth login' / the URL)" >&2; fi
                    fi
                    grep -qxF "/$_name/" "$PWD/.gitignore" 2>/dev/null || echo "/$_name/" >> "$PWD/.gitignore"
                done
                echo "  ✓ ${#_bs_repos[@]} sibling repo(s) cloned + gitignored (parent won't track them as gitlinks)"
            else
                echo "  ℹ multi-repo parent ready — clone your repos as siblings (they're auto-gitignored as you add them), or use --repo <url>"
            fi
        fi
        # Adopting/workspace + no git-provider token staged? nudge that SSH is the
        # canonical path for git ops (#10) and remind about API tokens if they want
        # host CLIs (gh/glab/…) to work. Non-fatal.
        if { [ -n "$_bs_adopt" ] || [ -n "$_bs_adopt_url" ] || [ -n "$_bs_workspace" ]; } && [ "${#_bs_seed[@]}" -eq 0 ] \
           && ! grep -qE '^(GH|GITLAB|BITBUCKET|GITEA)_TOKEN=' "$(cb_secrets_path "$PWD")" 2>/dev/null; then
            echo "  ℹ private repo(s)? git ops use SSH: add ~/.ssh/claudebox/id_ed25519.pub to your git host." >&2
            echo "     For provider CLI (gh/glab) inside claudebot, also seed an API token, e.g." >&2
            echo "       --seed-secret GH_TOKEN='gh auth token'" >&2
        fi
        # secrets: file-based only, so nothing sensitive is echoed or shell-history'd.
        if [ -n "$_bs_secfile" ]; then
            [ -f "$_bs_secfile" ] || { echo "bootstrap: --secrets-file not found: $_bs_secfile" >&2; exit 1; }
            _sn=0
            while IFS='=' read -r _k _v; do
                case "$_k" in ''|\#*) continue ;; esac
                cb_secrets_put "$PWD" "$_k" "$_v"; _sn=$((_sn + 1))
            done < "$_bs_secfile"
            echo "  ✓ $(cb_project_dot_basename "$PWD")/secrets.env ($_sn key(s) from $_bs_secfile; gitignored, chmod 600)"
        fi
        # --seed-secret KEY=CMD (repeatable): run CMD on the host, put stdout in secrets.env as KEY.
        # Handles --gh-token too (which appended GH_TOKEN=gh auth token above). Empty output = skipped
        # with a hint. Value never touches the command line beyond user's own CMD.
        if [ "${#_bs_seed[@]}" -gt 0 ]; then
            for _ss in "${_bs_seed[@]}"; do
                _k="${_ss%%=*}"; _c="${_ss#*=}"
                case "$_k" in ''|*[!A-Za-z0-9_]*) echo "  ⚠ --seed-secret: bad KEY '$_k' — skipped" >&2; continue ;; esac
                [ -n "$_c" ] || { echo "  ⚠ --seed-secret $_k: empty CMD — skipped" >&2; continue; }
                # Strip leading/trailing whitespace (incl. the trailing newline every
                # command has, and the leading space `gh auth token` prints).
                _val="$(eval "$_c" 2>/dev/null | awk '{sub(/^[[:space:]]+/,""); sub(/[[:space:]]+$/,""); print; exit}' || true)"
                if [ -n "$_val" ]; then
                    cb_secrets_put "$PWD" "$_k" "$_val"
                    echo "  ✓ $(cb_project_dot_basename "$PWD")/secrets.env: $_k (from host '$_c'; gitignored, chmod 600)"
                else
                    echo "  ⚠ --seed-secret $_k: '$_c' returned nothing — skipped" >&2
                fi
            done
        fi
        if [ -n "$_bs_start" ]; then
            echo "  ▶ starting claudebot…"
            # `start` is REQUIRED: bare `$0` has printed a version banner and exited since
            # #12 / 2.24.0, so this re-entry silently started nothing while announcing that
            # it had. Any self re-entry that means "launch" must name the verb.
            exec "$0" start   # re-enter the wrapper → boots the VM + claudebot with the brief
        fi
        echo "  (not started) enter later with:  cd $(printf '%q' "$PWD") && dridock start"
        exit 0
        ;;
esac

# Guards that catch the run paths (interactive / programmatic / daemon) before any VM
# work. Skipped for management/throwaway commands that legitimately run from anywhere.
#   cb_guard_workspace   — refuse to mount .dridock/.claudebox itself as the workspace (2.5.1)
#   cb_guard_new_project — refuse to silently spin up a fresh VM in some random dir
#   cb_check_infra_drift — warn (never block) if cb-infra image is behind the wrapper
# `bootstrap` is handled above and re-execs into the wrapper AFTER writing the project dir,
# so it never trips the new-project guard.
case "${1:-}" in
    setup-token|-v|--version|doctor|auth|mcp|stop|clear-session) : ;;
    *)
        cb_guard_workspace   "$CB_PROJECT_ROOT" || exit 1
        # Auto-migrate a legacy `.claudebox/`-only project to `.dridock/` before the
        # new-project guard would (incorrectly) offer to scaffold a fresh project on
        # top of one that's already there but under the legacy dotname. #11 phase 4b.
        cb_auto_migrate      "$CB_PROJECT_ROOT"
        cb_guard_new_project "$CB_PROJECT_ROOT" || exit 1
        cb_check_infra_drift "$CB_PROJECT_ROOT"
        ;;
esac

# ── project identity → colima context (Phase 4) ──────────────────────────────
# Every docker call below runs against the project's own VM via `"${DOCKER[@]}"`.
CB_PROJECT_ID="$(cb_project_id "$CB_PROJECT_ROOT")"
CB_CONTEXT="$(cb_project_context "$CB_PROJECT_ID")"
DOCKER=(docker --context "$CB_CONTEXT")
dbg "project id=$CB_PROJECT_ID context=$CB_CONTEXT"

# ── resolve the per-project data dir (shared-nothing) unless overridden ───────
# Each project gets its own ~/.claude state under ~/.config/dridock/projects/<id>.
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
    -e DRIDOCK_GIT_NAME="$CLAUDE_GIT_NAME"
    -e DRIDOCK_GIT_EMAIL="$CLAUDE_GIT_EMAIL"
    -e DRIDOCK_WORKSPACE="$PWD"
    -e DRIDOCK_CONTAINER_NAME="$container_name"
    -v "$CLAUDE_SSH:/home/claude/.ssh"
    -v "$CLAUDE_DIR:/home/claude/.claude"
    -v "$PWD:$PWD"
    -v /var/run/docker.sock:/var/run/docker.sock
)

# Approach B: if a CDP bridge is up for this project, inject its URL so claudebot
# can drive the human's Chrome (cb-browser cdp). Marker written by browser-bridge up.
# The -e injection only reaches a FRESH container (docker run); an already-created
# container restarted via `docker start` never sees it. So ALSO persist the URL to a
# per-role sidecar the entrypoint re-reads on every start (same durability pattern as
# auth/secrets) — this is what makes `browser-bridge up` take effect on the running
# claudebot without recreating it. Empty sidecar = bridge down -> entrypoint unsets it.
_cdp_marker="$(cb_cdp_marker "$CB_PROJECT_ID")"
_cdp_url=""; [ -f "$_cdp_marker" ] && _cdp_url="$(cat "$_cdp_marker" 2>/dev/null)"
if [ -n "$_cdp_url" ]; then
    DOCKER_ARGS+=(-e "DRIDOCK_HOST_CDP_URL=$_cdp_url")
    dbg "CDP bridge URL injected: $_cdp_url"
fi
for _crole in "" _prog _cron; do
    printf 'DRIDOCK_HOST_CDP_URL=%s\n' "$_cdp_url" > "$CLAUDE_DIR/.${container_name}${_crole}-cdp"
done

# Reachable VM IP -> claudebot as DRIDOCK_VM_IP. The claudebot container sits on the
# VM's docker bridge (172.x), so it CANNOT self-discover the VM's reachable col0 IP
# (192.168.64.x) — the only address the human's Mac (and its Chrome, for CDP) can hit a
# published workload at. Done via cb_inject_vm_env called AFTER cb_ensure_vm at each
# mode's dispatch site (see below): if injected here we'd race a first-boot VM (not up
# yet -> lookup empty -> env never set) — the pre-fix first-run bug. cb_inject_vm_env
# uses cb_wait_reachable so col0's few-second lag past `colima start` is handled, and
# writes a per-role sidecar entrypoint re-reads on every `docker start` so IP rotation
# self-heals. HOSTNAME (network.hostname from config.yml) rides the same sidecar as the
# rotation-proof escape hatch.

# Host agent (Approach 2) — if the OPT-IN agent is up, inject its URL + token so the
# baked colima/limactl shims can proxy to the Mac. Durable sidecar (empty when the agent is
# down → entrypoint unsets it), same self-healing pattern as the CDP/VM-IP sidecars.
_ha_home="$(cb_host_agent_home)"; _ha_url= _ha_tok=
if [ -f "$_ha_home/pid" ] && kill -0 "$(cat "$_ha_home/pid" 2>/dev/null)" 2>/dev/null && [ -f "$_ha_home/token" ]; then
    _ha_url="$CB_HOST_AGENT_BIND:$CB_HOST_AGENT_PORT"; _ha_tok="$(cat "$_ha_home/token")"
    # The token rides the sidecar below only — never `-e`, which would expose it in the
    # Mac's `ps` output for the whole session. See the auth comment further down.
fi
for _crole in "" _prog _cron; do
    { printf 'DRIDOCK_HOST_AGENT_URL=%s\n' "$_ha_url"
      printf 'DRIDOCK_HOST_AGENT_TOKEN=%s\n' "$_ha_tok"; } > "$CLAUDE_DIR/.${container_name}${_crole}-hostagent"
    chmod 600 "$CLAUDE_DIR/.${container_name}${_crole}-hostagent" 2>/dev/null || true
done

# Shared framework-bug drop dir — mount it into every container so cb-report-bug can
# file suspected FRAMEWORK bugs (wrapper/entrypoint/image/networking) to one place.
_fwbugs="$(cb_fwbugs_home)"; mkdir -p "$_fwbugs" 2>/dev/null || true
DOCKER_ARGS+=(-v "$_fwbugs:/home/claude/framework-bugs")
DOCKER_ARGS+=(-e "DRIDOCK_FRAMEWORK_BUGS_DIR=/home/claude/framework-bugs")
DOCKER_ARGS+=(-e "DRIDOCK_PROJECT_ID=$CB_PROJECT_ID")
_fwb_n=$(find "$_fwbugs" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "${_fwb_n:-0}" -gt 0 ] && echo "⚠ $_fwb_n framework bug report(s) on file — review: $CB_SELF framework-bugs" >&2

# Opt-in: RAM-back the claudebot's /tmp so docker disk bloat can't starve the Bash tool
# (it writes /tmp/claude-501 per command; when the shared VM overlay fills, mkdir there fails
# with ENOSPC and every command dies). DRIDOCK_TMPFS_TMP=<size like 2g>, or 1/on for 2g.
# --tmpfs only applies to a fresh `docker run` (not `docker start`). See docs/design/disk-management.md.
case "${DRIDOCK_TMPFS_TMP:-${CLAUDE_TMPFS_TMP:-}}" in
    ''|0|false|no|off) : ;;
    1|true|yes|on)     DOCKER_ARGS+=(--tmpfs "/tmp:size=2g,exec,mode=1777") ;;
    *)                 DOCKER_ARGS+=(--tmpfs "/tmp:size=${DRIDOCK_TMPFS_TMP:-${CLAUDE_TMPFS_TMP}},exec,mode=1777") ;;
esac

# Shared consult dir — mount it so cb-consult can open/read supervised framework threads.
_consult="$(cb_consult_home)"; mkdir -p "$_consult" 2>/dev/null || true
DOCKER_ARGS+=(-v "$_consult:/home/claude/framework-consult")
DOCKER_ARGS+=(-e "DRIDOCK_CONSULT_DIR=/home/claude/framework-consult")
# Surface pending consults the way checkversion warns — the human is the approval gate.
_c_appr=0; _c_draft=0
if [ -d "$_consult" ]; then
    for _td in "$_consult"/*/; do
        [ -d "$_td" ] || continue
        case "$(cb_consult_status "${_td%/}")" in
            awaiting-approval) _c_appr=$((_c_appr + 1)) ;;
            awaiting-framework) _c_draft=$((_c_draft + 1)) ;;
        esac
    done
fi
[ "$_c_appr" -gt 0 ] && echo "🗣  $_c_appr framework consult(s) awaiting YOUR approval — review: $CB_SELF consult list" >&2
[ "$_c_draft" -gt 0 ] && echo "🗣  $_c_draft framework consult(s) awaiting a framework draft — see: $CB_SELF consult list" >&2

# forward env vars to the container
# Auth deliberately does NOT ride `-e`. `docker run -e KEY=<value>` puts the secret in
# the docker CLI's OWN argv, which `ps aux` on the Mac exposes to every local user for
# the entire life of an interactive session, and pins it into the container's Config.Env
# where `docker inspect` hands it to anything holding the socket. The `.<container>-auth`
# sidecar written just below is the only channel: the entrypoint re-reads it on EVERY
# start and exports it there, which also covers `docker start` (can't take new env).
# Same rule as secrets — see docs/design/git-and-api-auth.md § Secret handling.
[ "$DEBUG" = "true" ] && DOCKER_ARGS+=(-e "DEBUG=true")
# opt out of the baked default plugin set (entrypoint seeds settings.json otherwise)
[ -n "${DRIDOCK_DEFAULT_PLUGINS:-}" ] && DOCKER_ARGS+=(-e "DRIDOCK_DEFAULT_PLUGINS=$DRIDOCK_DEFAULT_PLUGINS")


# forward DRIDOCK_ENV_* / CLAUDEBOX_ENV_* / CLAUDE_ENV_* vars (strip prefix: FOO=bar)
# TWO channels, both required (#30):
#   - `-e FOO=bar` on docker run — takes effect on the FIRST run when the container
#     is being created. Cannot be re-applied on `docker start`, which is what every
#     subsequent invocation of a still-existing container takes.
#   - `.${container_name}${_role}-env` sidecar (KEY=VALUE, chmod 600) — the
#     entrypoint's `_load_env_sidecar env` re-reads this on EVERY start, so a
#     changed DRIDOCK_ENV_FOO value takes effect on the next `docker start` too.
#     Pre-#30 the wrapper only had the -e path, so DRIDOCK_ENV_FOO silently no-oped
#     on restarted containers (recurring rediscovery — see #30 body). The sidecar
#     kills the class.
# Security: -env goes chmod 600 like -auth/-secrets — the values can carry
# credentials (DRIDOCK_ENV_ANTHROPIC_API_KEY is a documented pattern), and
# 0600-file is strictly better than the -e-in-docker-argv leak surface.
_ENV_LINES=""
while IFS='=' read -r name value; do
    case "$name" in
        DRIDOCK_ENV_*)   stripped="${name#DRIDOCK_ENV_}" ;;
        CLAUDEBOX_ENV_*) stripped="${name#CLAUDEBOX_ENV_}" ;;
        CLAUDE_ENV_*)    stripped="${name#CLAUDE_ENV_}" ;;
        *) continue ;;
    esac
    DOCKER_ARGS+=(-e "$stripped=$value")
    _ENV_LINES+="$stripped=$value"$'\n'
    dbg "forwarding env: $stripped (+ -env sidecar)"
done < <(env | grep -E "^(DRIDOCK_ENV_|CLAUDEBOX_ENV_|CLAUDE_ENV_)")
# Write the sidecar for each container role (always — even when empty, so a stale
# sidecar from a prior run doesn't survive a run with no forwards). Same three-role
# pattern as -auth/-secrets.
for _erole in "" _prog _cron; do
    _ef="$CLAUDE_DIR/.${container_name}${_erole}-env"
    printf '%s' "$_ENV_LINES" > "$_ef"
    chmod 600 "$_ef"
done
unset _ENV_LINES _erole _ef

# mount extra volumes via DRIDOCK_MOUNT_* / CLAUDEBOX_MOUNT_* / CLAUDE_MOUNT_*
while IFS='=' read -r name value; do
    case "$value" in
        *:*) DOCKER_ARGS+=(-v "$value") ;;
        *)   DOCKER_ARGS+=(-v "$value:$value") ;;
    esac
    dbg "mounting volume: $value"
done < <(env | grep -E "^(DRIDOCK_MOUNT_|CLAUDEBOX_MOUNT_|CLAUDE_MOUNT_)")

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

# ── inject machine-local project secrets (.dridock/secrets.env) ──────────────
# (a) forward each KEY=VALUE as env for THIS run and (b) persist to per-container
# sidecars the entrypoint re-reads on every start — so secrets survive `docker
# start` (which can't take new env). Same durable pattern as the auth files above.
SECRETS_SRC="$(cb_secrets_path "$CB_PROJECT_ROOT")"
if [ -f "$SECRETS_SRC" ]; then
    # No `-e` here — see the auth comment above. The sidecars below are the sole channel;
    # the entrypoint exports them on every start, so this covers first run AND restart.
    dbg "secrets -> sidecars only (never the docker command line)"
    for _srole in "" _prog _cron; do
        cp "$SECRETS_SRC" "$CLAUDE_DIR/.${container_name}${_srole}-secrets"
        chmod 600 "$CLAUDE_DIR/.${container_name}${_srole}-secrets"
    done
    dbg "wrote secrets sidecars from $SECRETS_SRC"
fi

# ── features: enabled bundles the entrypoint installs on first enable ────────
# Write the project's `features:` (or legacy `profiles:`) list to a sidecar the
# entrypoint reads each start and installs from (once per feature, marker-guarded —
# see docs/design/features-system.md). Read from the mount so adding a feature takes
# effect on the next run without recreating. The legacy `.profiles` sidecar is
# removed here on 3.0 upgrade so a running container doesn't see stale data.
_features="$(cb_project_features "$CB_PROJECT_ROOT")"
if [ -n "$_features" ]; then
    printf '%s\n' "$_features" > "$CLAUDE_DIR/.features"
    rm -f "$CLAUDE_DIR/.profiles" 2>/dev/null || true
    dbg "enabled features: $_features"
else
    rm -f "$CLAUDE_DIR/.features" "$CLAUDE_DIR/.profiles" 2>/dev/null || true
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

# ip — print JUST the project VM's current reachable IP (scriptable, one line). The IP
# rotates across VM restarts, so this is the fresh source to feed a config/allowlist;
# never hardcode a past value. `net [hostname]` prints the full browse dashboard (and,
# with a name, first SETS network.hostname in config.yml — no hand-editing YAML).
if [ "${1:-}" = "ip" ]; then
    cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
    _ip="$(cb_wait_reachable "$(cb_project_profile "$CB_PROJECT_ID")")"
    [ -n "$_ip" ] && { echo "$_ip"; exit 0; }
    echo "VM has no reachable IP yet (try again in a moment)." >&2; exit 1
fi
if [ "${1:-}" = "net" ]; then
    if [ -n "${2:-}" ]; then cb_set_hostname "$CB_PROJECT_ROOT" "$2" || exit 1; fi
    cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
    cb_network_info "$CB_PROJECT_ROOT" "$CB_PROJECT_ID"
    exit 0
fi

# cron mode — long-running daemon container, named <base>_cron
_mode_cron="${DRIDOCK_MODE_CRON:-${CLAUDE_MODE_CRON:-}}"
_mode_cron_file="${DRIDOCK_MODE_CRON_FILE:-${CLAUDE_MODE_CRON_FILE:-}}"
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
        -e "DRIDOCK_MODE_CRON=1"
        -e "DRIDOCK_WORKSPACE=$PWD"
        -e "DRIDOCK_CONTAINER_NAME=$cron_name"
    )
    [ -n "$_mode_cron_file" ] && CRON_ARGS+=(-e "DRIDOCK_MODE_CRON_FILE=$_mode_cron_file")
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
        # `-it` is needed by interactive passthroughs — `auth login` (browser OAuth,
        # requires TTY to print the URL + wait for callback) and `mcp` (interactive
        # picker in some paths). Read-only verbs like `-v`/`--version`/`doctor` don't
        # need TTY but tolerate it fine. Same-shape addition covers all of them; #16.
        #
        # This is the ONE path that still needs env on the docker command line: it runs
        # `--entrypoint claude`, so the entrypoint never runs and never reads the sidecars.
        # Use `--env-file` rather than `-e` so only a PATH lands in argv, never a value.
        # Only non-empty entries are written, because `--env-file` turns a bare `KEY=` into
        # a set-but-empty var, which claude treats as a present (broken) credential.
        _pt_env="$(cb_mktemp_envfile "$CLAUDE_DIR/.${container_name}-auth")"
        [ -n "$_pt_env" ] && trap 'rm -f "$_pt_env"' EXIT
        "${DOCKER[@]}" run --rm -it --entrypoint claude \
            ${_pt_env:+--env-file "$_pt_env"} "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE "$@"
        _pt_rc=$?
        [ -n "$_pt_env" ] && rm -f "$_pt_env"
        exit $_pt_rc
        ;;
esac

# Parse and validate args.
# The strict allowlist below applies to `-p` PROGRAMMATIC mode (which pipes through
# jsonpipe.py and needs a fixed flag set). It must NOT reject flags in INTERACTIVE
# mode — `claudebox start --any-flag` should pass every flag straight to `claude`
# inside the container. Pre-scan for -p/--print; if absent, skip the validator
# entirely and let $@ reach the interactive claude invocation unmodified. Fix for
# the "❌ Unknown flag: --remote-control" regression that surfaced when `start`
# became an explicit verb in 2.24.0.
_has_p_flag=0
for _arg in "$@"; do case "$_arg" in -p|--print) _has_p_flag=1; break ;; esac; done

if [ $# -gt 0 ] && [ "$_has_p_flag" = "1" ]; then
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
                --effort)
                    # #31 — claude silently ignores unrecognized effort values, so a
                    # typo like `--effort hihg` runs at default effort with no signal.
                    # Validate against the closed set the CLI supports. --model
                    # deliberately stays unvalidated (model names rot; an allowlist
                    # would start rejecting valid models).
                    case "$arg" in
                        low|medium|high|xhigh|max) ;;
                        *) echo "❌ Invalid effort: $arg (allowed: low, medium, high, xhigh, max)"; exit 1 ;;
                    esac
                    ;;
                --model|--system-prompt|--append-system-prompt|--json-schema|--resume) ;;
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
            --effort=*)
                # #31 — same validation as the split --effort X form above.
                eff="${arg#--effort=}"
                case "$eff" in
                    low|medium|high|xhigh|max) ;;
                    *) echo "❌ Invalid effort: $eff (allowed: low, medium, high, xhigh, max)"; exit 1 ;;
                esac
                PASS_ARGS+=("$arg")
                ;;
            --model=*|--system-prompt=*|--append-system-prompt=*|--json-schema=*|--resume=*)
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
        cb_caffeinate   # opt-in (DRIDOCK_CAFFEINATE=1): keep the Mac awake for this run
        cb_refresh_container "$CB_CONTEXT" "$prog_name"   # recreate if image was reseeded
        prog_rc=0
        if ! "${DOCKER[@]}" ps -a --format '{{.Names}}' | grep -q "^${prog_name}$"; then
            dbg "prog: container does not exist, creating with docker run"
            if [ -n "$PIPE_MODE" ]; then
                "${DOCKER[@]}" run --name "$prog_name" "${DOCKER_ARGS[@]}" -e DRIDOCK_CONTAINER_NAME="$prog_name" $CLAUDE_IMAGE "${PASS_ARGS[@]}" \
                    | "${DOCKER[@]}" run --rm -i --entrypoint python3 $CLAUDE_IMAGE /home/claude/jsonpipe.py "$PIPE_MODE"
                prog_rc=${PIPESTATUS[0]}
            else
                "${DOCKER[@]}" run --name "$prog_name" "${DOCKER_ARGS[@]}" -e DRIDOCK_CONTAINER_NAME="$prog_name" $CLAUDE_IMAGE "${PASS_ARGS[@]}"
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

# 3.0.1: forward user-supplied flags to `dridock start <flags...>` via a durable
# sidecar the entrypoint re-reads on each start. Fixes the silent-drop bug where
# `docker run -it` doesn't pass "$@" and `docker start -ai` can't accept new args.
# At this point _has_p_flag == 0 (else we'd have exited via the programmatic
# branch above), so any remaining $@ is intended for the interactive claude.
INTERACTIVE_ARGS_FILE="$CLAUDE_DIR/.${container_name}-interactive-args"
if [ $# -gt 0 ]; then
    printf '%q ' "$@" > "$INTERACTIVE_ARGS_FILE"
    dbg "interactive extras -> $INTERACTIVE_ARGS_FILE: $*"
else
    rm -f "$INTERACTIVE_ARGS_FILE" 2>/dev/null || true
fi

# Interactive — ensure the project VM (+ image) is up first
cb_ensure_vm "$CB_PROJECT_ROOT" "$CB_PROJECT_ID" || exit 1
cb_network_info "$CB_PROJECT_ROOT" "$CB_PROJECT_ID"

# (#17) --remote-control against an image whose claude predates the flag. Claude Code
# ignores unknown flags silently (exit 0), so this otherwise fails invisibly: the
# session starts, looks healthy, RC never activates, nothing anywhere says why.
#
# This check MUST stay host-side. The obvious place is the entrypoint, but probing
# `claude --help` there deadlocks PID 1: claude touches the container tty from a
# non-foreground process group, stops on SIGTTOU/SIGTTIN, and `timeout` cannot reap a
# STOPPED process. Out here it's a plain `docker run --rm` with no tty — nothing to
# stop on. Runs only when the flag is actually present, after the VM is guaranteed up.
# Match the flag with a trailing boundary: a bare `*--remote-control*` would also fire
# on `--remote-control-session-name-prefix`, the decoy option old CLIs carry.
case " $* " in
    *" --remote-control "*|*" --remote-control="*|*" --rc "*|*" --rc="*)
        _rc_cli="$(cb_image_claude_version "$CB_CONTEXT")"
        if [ "$_rc_cli" != unavailable ] && [ "$(cb_semver_cmp "$_rc_cli" "$CB_CLAUDE_CLI_FLOOR")" = lt ]; then
            echo "⚠️  --remote-control: this project's image ships Claude Code $_rc_cli, which has no" >&2
            echo "    --remote-control flag (needs >= $CB_CLAUDE_CLI_FLOOR). claude IGNORES unknown flags" >&2
            echo "    silently, so the session will start and Remote Control just won't activate." >&2
            echo "    The CLI is baked into the image and can't self-update. Fix:" >&2
            echo "      make build     # bump Dockerfile ARG CLAUDE_VERSION first if it's still old" >&2
            echo "    Continuing anyway — everything except Remote Control works normally." >&2
        fi ;;
esac

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
cb_caffeinate   # opt-in (DRIDOCK_CAFFEINATE=1): keep the Mac awake for this session
cb_refresh_container "$CB_CONTEXT" "$container_name"   # recreate if the image was reseeded (e.g. after make build)
if "${DOCKER[@]}" ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
    echo "🔄 Starting container '$container_name'..."
    "${DOCKER[@]}" start -ai "$container_name"
else
    echo "🔧 Creating container '$container_name'..."
    "${DOCKER[@]}" run -it --name "$container_name" "${DOCKER_ARGS[@]}" $CLAUDE_IMAGE
fi

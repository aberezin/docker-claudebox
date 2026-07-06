#!/usr/bin/env bash
# claudebox-shell.sh — convenience shell helpers for getting into a claudebox
# project's Colima VM and containers. Source this from your ~/.bashrc / ~/.zshrc:
#
#     source /path/to/claudebox-shell.sh
#
# (install.sh does this for you.) Everything is scoped to the PER-PROJECT Colima
# context, which is derived from the project's .claudebox/config.yml — so these work
# from any subdirectory of a claudebox project and never touch your default VM.
#
# Layers you can shell into:
#     project VM  (colima cb-<id>, a Linux guest)   -> cbx-vm
#       └─ a workload container (e.g. todo-app)      -> cbx-sh <name>
#       └─ claudebot's own harness container         -> cbx-claude
#
# Commands:
#     cbx-ps                 list containers running in this project's VM
#     cbx-sh <name> [cmd…]   shell into a container (no cmd = interactive; cmd = run it)
#     cbx-logs <name> [args] docker logs for a container in this project's VM
#     cbx-vm [cmd…]          ssh into the project VM itself (no cmd = interactive)
#     cbx-claude             shell into this workspace's claudebot harness container
#     cbx-claude-dir [-o]    print this project's host .claude data dir (-o opens it)

# resolve the project id by walking up for .claudebox/config.yml
_cbx_id() {
    local d; d="$(cd -P "$PWD" 2>/dev/null && pwd)"
    while [ -n "$d" ] && [ "$d" != "/" ]; do
        if [ -f "$d/.claudebox/config.yml" ]; then
            awk -F'[: ]+' '/^id:/{print $2; exit}' "$d/.claudebox/config.yml"; return 0
        fi
        d="$(dirname "$d")"
    done
    echo "cbx: no .claudebox/config.yml at or above $PWD (not a claudebox project?)" >&2
    return 1
}
_cbx_ctx() { local id; id="$(_cbx_id)" || return 1; printf 'colima-cb-%s' "$id"; }

# list containers in this project's VM
cbx-ps() { local c; c="$(_cbx_ctx)" || return 1; docker --context "$c" ps "$@"; }

# shell into a container (no args = interactive shell; with args = run them)
cbx-sh() {
    local c n; c="$(_cbx_ctx)" || return 1
    n="${1:?usage: cbx-sh <container> [cmd...]}"; shift
    if [ "$#" -gt 0 ]; then
        docker --context "$c" exec -i "$n" "$@"                  # scriptable (no forced TTY)
    else
        docker --context "$c" exec -it "$n" bash 2>/dev/null \
            || docker --context "$c" exec -it "$n" sh            # interactive
    fi
}

# logs for a container in this project's VM
cbx-logs() { local c; c="$(_cbx_ctx)" || return 1; docker --context "$c" logs "$@"; }

# ssh into the project VM (Lima guest); no args = interactive shell
cbx-vm() {
    local id; id="$(_cbx_id)" || return 1
    if [ "$#" -gt 0 ]; then colima ssh -p "cb-$id" -- "$@"; else colima ssh -p "cb-$id"; fi
}

# shell into THIS workspace's claudebot harness container. That container only runs
# during an INTERACTIVE session (`claudebox`); `claudebox -p` uses an ephemeral
# _prog container that exits. If it isn't up, say how to start one rather than
# emitting a raw "container is not running" daemon error.
cbx-claude() {
    local c n st; c="$(_cbx_ctx)" || return 1
    n="claude-$(cd -P "$PWD" 2>/dev/null && pwd | sed 's:/:_:g')"
    st="$(docker --context "$c" inspect -f '{{.State.Running}}' "$n" 2>/dev/null)"
    if [ "$st" != "true" ]; then
        echo "cbx-claude: claudebot's harness container ('$n') isn't running." >&2
        echo "  It only runs during an interactive session — start one with:  claudebox" >&2
        echo "  To shell into a workload container instead:  cbx-ps   then   cbx-sh <name>" >&2
        return 1
    fi
    docker --context "$c" exec -it "$n" bash 2>/dev/null || docker --context "$c" exec -it "$n" sh
}

# print this project's host .claude data dir (authoritative — asks the wrapper so it
# respects any data_root / CLAUDEBOX_DATA_DIR override). `-o` opens it (macOS Finder).
cbx-claude-dir() {
    local d
    if command -v claudebox >/dev/null 2>&1; then
        d="$(claudebox claude-dir)" || return 1
    else
        local id; id="$(_cbx_id)" || return 1
        d="${XDG_CONFIG_HOME:-$HOME/.config}/claudebox/projects/$id/claude"
    fi
    if [ "${1:-}" = "-o" ]; then command open "$d" 2>/dev/null || printf '%s\n' "$d"
    else printf '%s\n' "$d"; fi
}

# ── tab-completion: complete container names for cbx-sh / cbx-logs ────────────
# Completes the first argument from the containers live in this project's VM.
_cbx_complete_containers() {
    local ctx names cur
    ctx="$(_cbx_ctx 2>/dev/null)" || return 0
    names="$(docker --context "$ctx" ps --format '{{.Names}}' 2>/dev/null)"
    cur="${COMP_WORDS[COMP_CWORD]}"
    if [ "${COMP_CWORD:-1}" -eq 1 ]; then
        # shellcheck disable=SC2207
        COMPREPLY=( $(compgen -W "$names" -- "$cur") )
    fi
}
# zsh can run bash-style completions via bashcompinit
if [ -n "${ZSH_VERSION:-}" ]; then
    autoload -Uz bashcompinit 2>/dev/null && bashcompinit 2>/dev/null
fi
if command -v complete >/dev/null 2>&1; then
    complete -F _cbx_complete_containers cbx-sh cbx-logs 2>/dev/null
fi

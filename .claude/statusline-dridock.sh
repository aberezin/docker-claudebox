#!/usr/bin/env bash
# Claude Code statusLine — shows the dridock colima profile for the current
# project as `🚢 cb-<id>`. Silent when the cwd isn't in a dridock project so
# the statusLine stays empty in non-harness projects.
#
# Reads .dridock/config.yml directly (no `dridock` binary shell-out). Walks
# upward from the starting dir to catch the case where the user cd'd into a
# subdir.
#
# COST: ~38ms/render for the jq+bash startup this script already pays, plus
# ~23ms for the work-indicator scan below. An earlier header claimed
# "sub-millisecond"; that was never measured and isn't true. Keep new work
# here to single process scans and avoid `docker` shell-outs, which are an
# order of magnitude worse.
#
# Input contract (Claude Code): a JSON payload on stdin with a `.cwd` field.
# Falls back to $CLAUDE_PROJECT_DIR then $PWD if stdin is empty or lacks jq.
# Output: one line to stdout (may be empty).
set -u

# ── resolve starting dir ─────────────────────────────────────────────
input="$(cat 2>/dev/null || true)"
cwd=""
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
    cwd="$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null)"
fi
[ -z "$cwd" ] && cwd="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$cwd" ] || exit 0

# ── long-running work indicator (#66) ────────────────────────────────
# Printed BEFORE the dridock-project walk below, and deliberately NOT
# gated by it. That walk exits silently outside a dridock project, and
# the harness repo itself is not one (no .dridock/config.yml anywhere up
# the tree) — which is precisely where the 8-40 minute `bash test.sh`
# and `make build` runs happen. Gating this on the walk would reproduce
# the invisibility it exists to fix.
#
# Detection is by RUNNING PROCESS rather than a marker file the launcher
# has to remember to write, so an ad-hoc `bash test.sh` shows up with no
# cooperation from whoever started it. Same reasoning as the #63 runner
# fix: a property that depends on the author remembering isn't a
# property.
#
# `pgrep -o` selects the OLDEST match — the run itself rather than a
# short-lived child — so the elapsed time shown is the one worth seeing.
#
# ONE pgrep covering all patterns, then ONE ps for elapsed + label.
# Measured here: three separate pgreps cost 58ms/render, this costs 23ms.
_busy_pid="$(pgrep -o -f 'bash .*test\.sh|docker( [a-z-]+)* build|make( [a-zA-Z-]+)* build' 2>/dev/null || true)"

if [ -n "$_busy_pid" ]; then
    # `read` (not `${_info%% *}`) because Linux procps-ng LEFT-PADS etime while
    # BSD ps does not:
    #
    #   macOS   [00:01 sleep 30]        -> ${_info%% *} = "00:01"   ok
    #   Linux   [      00:01 sleep 30]  -> ${_info%% *} = ""        elapsed vanishes
    #
    # `%%` takes the longest prefix up to a space, so leading whitespace makes it
    # split at position 0 and yield the empty string — the segment then rendered
    # as a bare "⏳ tests " with no time, which is most of the value gone. `read`
    # strips leading IFS and splits on the first gap, so it is correct on both.
    # Caught by Bear dogfooding in-container on #66; not reproducible on macOS.
    _et=""; _cmd=""
    read -r _et _cmd < <(ps -o etime=,command= -p "$_busy_pid" 2>/dev/null) || true
    case "$_cmd" in
        *test.sh*) _busy_label="tests" ;;
        *)         _busy_label="build" ;;
    esac
    # etime is [[DD-]HH:]MM:SS. Normalise so "10:08" can't be misread as
    # ten hours.
    _human="$(printf '%s' "$_et" | awk -F'[-:]' '
        NF==2 { printf "%dm%02ds", $1, $2; next }
        NF==3 { printf "%dh%02dm", $1, $2; next }
        NF==4 { printf "%dd%02dh", $1, $2; next }
        { print }
    ' 2>/dev/null)"
    [ -z "$_human" ] && _human="$_et"
    # Yellow: reads as in-progress on light and dark terminals alike, and
    # is distinct from the cyan used for the profile segment below.
    printf '\033[33m⏳ %s %s\033[0m ' "$_busy_label" "$_human"
fi

# ── walk up looking for .dridock/config.yml ──────────────────────────
dir="$cwd"
while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    # dridock disabled in this tree (.nodridock, e.g. the harness repo itself,
    # or any session running natively on the Mac) → no colima VM to surface.
    # Checked BEFORE config.yml so a repo that has both (like docker-claudebox)
    # stays silent. Marker protects every subdir, so a hit anywhere up = silent.
    if [ -f "$dir/.nodridock" ]; then
        exit 0
    fi
    if [ -f "$dir/.dridock/config.yml" ]; then
        id=$(sed -nE 's/^id:[[:space:]]*([A-Za-z0-9_-]+).*$/\1/p' "$dir/.dridock/config.yml" | head -1)
        if [ -n "$id" ] && [ "$id" != "auto" ]; then
            # Cyan for readability on both light + dark terminals. Emoji ship
            # marks it as harness-context; text says the profile the user needs
            # for colima/docker/limactl.
            printf '\033[36m🚢 cb-%s\033[0m' "$id"
        fi
        exit 0
    fi
    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && break
    dir="$parent"
done
# Not in a dridock project: silent (empty statusLine).

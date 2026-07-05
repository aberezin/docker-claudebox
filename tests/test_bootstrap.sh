#!/usr/bin/env bash
# Standalone unit tests for the bootstrap scaffolder in wrapper.sh.
# Pure host-side — no docker, no colima, no auth token needed.
#
# Run:  bash tests/test_bootstrap.sh
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
has() { grep -q "$1" "$2" 2>/dev/null; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── preflight: assert required host tooling before scaffolding ───────────────
# passes on a normal dev machine (colima/docker/git present here)
if ( cb_preflight full >/dev/null 2>&1 ); then ok "preflight passes with tooling present"; else bad "preflight failed unexpectedly (missing colima/docker/git?)"; fi
# an empty PATH hides colima/docker -> hard failure
if ( PATH="" cb_preflight full >/dev/null 2>&1 ); then bad "preflight passed with no tooling on PATH"; else ok "preflight fails when required tools missing"; fi
# explicit override short-circuits even with nothing on PATH
if ( PATH="" CLAUDEBOX_SKIP_PREFLIGHT=1 cb_preflight full >/dev/null 2>&1 ); then ok "CLAUDEBOX_SKIP_PREFLIGHT=1 overrides"; else bad "SKIP_PREFLIGHT did not override"; fi

# scaffolding assertions below test pure file layout — decouple from tooling presence
export CLAUDEBOX_SKIP_PREFLIGHT=1

# ── full mode: git init + starter files + brief + config ─────────────────────
P1="$TMP/proj-full"; mkdir -p "$P1"
out="$(cb_bootstrap "$P1" "Build Project-A: a 3-tier app." full 2>&1)"
[ -f "$P1/.claudebox/BRIEF.md" ]        && ok "full: BRIEF.md written"          || bad "full: BRIEF.md missing"
[ -f "$P1/.claudebox/config.yml" ]      && ok "full: config.yml written"        || bad "full: config.yml missing"
[ -d "$P1/.git" ]                       && ok "full: git init'd"                || bad "full: no .git"
[ -f "$P1/README.md" ]                  && ok "full: README.md written"         || bad "full: README missing"
[ -d "$P1/workloads" ]                  && ok "full: workloads/ created"        || bad "full: no workloads/"
has "Build Project-A" "$P1/.claudebox/BRIEF.md" && ok "full: intent captured"   || bad "full: intent not in brief"
has "Progress / handoff log" "$P1/.claudebox/BRIEF.md" && ok "full: two-way handoff section" || bad "full: no handoff log"

# BRIEF.md is COMMITTED — must NOT be in .gitignore; config.yml MUST be
if [ -f "$P1/.gitignore" ]; then
    has "config.yml" "$P1/.gitignore" && ok "config.yml gitignored"             || bad "config.yml not gitignored"
    if has "BRIEF.md" "$P1/.gitignore"; then bad "BRIEF.md wrongly gitignored"; else ok "BRIEF.md not gitignored (committed)"; fi
else
    bad "no .gitignore after git init"
fi

# ── refuse to clobber an existing brief without --force ──────────────────────
if cb_bootstrap "$P1" "different intent" full "" >/dev/null 2>&1; then
    bad "clobbered existing brief without --force"
else
    ok "refuses to overwrite brief without --force"
fi
has "Build Project-A" "$P1/.claudebox/BRIEF.md" && ok "original brief preserved" || bad "brief changed despite refusal"

# ── --force overwrites ───────────────────────────────────────────────────────
cb_bootstrap "$P1" "Rebuilt intent XYZ" full 1 >/dev/null 2>&1
has "Rebuilt intent XYZ" "$P1/.claudebox/BRIEF.md" && ok "--force overwrites brief" || bad "--force did not overwrite"

# ── brief-only mode: no git/README/workloads ─────────────────────────────────
P2="$TMP/proj-brief"; mkdir -p "$P2"
cb_bootstrap "$P2" "Just the brief." brief "" >/dev/null 2>&1
[ -f "$P2/.claudebox/BRIEF.md" ]   && ok "brief-only: BRIEF.md written"    || bad "brief-only: no BRIEF.md"
[ -f "$P2/.claudebox/config.yml" ] && ok "brief-only: config.yml written"  || bad "brief-only: no config.yml"
[ ! -d "$P2/.git" ]                && ok "brief-only: no git init"          || bad "brief-only: unexpectedly git init'd"
[ ! -f "$P2/README.md" ]           && ok "brief-only: no README"           || bad "brief-only: unexpected README"
[ ! -d "$P2/workloads" ]           && ok "brief-only: no workloads/"        || bad "brief-only: unexpected workloads/"

# ── empty intent falls back to a TODO placeholder ────────────────────────────
P3="$TMP/proj-empty"; mkdir -p "$P3"
cb_bootstrap "$P3" "" brief "" >/dev/null 2>&1
has "TODO" "$P3/.claudebox/BRIEF.md" && ok "empty intent -> TODO placeholder" || bad "empty intent: no placeholder"

echo ""
echo "bootstrap: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

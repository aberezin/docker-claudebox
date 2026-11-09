#!/bin/bash

# ── #98: the marketplace a plugin installs FROM is named by its own manifest ──
#
# `claude plugin install` addresses a marketplace by the `name` field inside
# that marketplace's `.claude-plugin/marketplace.json`, not by the repo it was
# cloned from. #96 derived it from the repo slug, which is right only when the
# two coincide -- as they do for `anthropics/claude-plugins-official`, the one
# marketplace #96 ever exercised. So the hardcoded default worked by
# coincidence and the defect stayed invisible until `aberezin/superpowers`
# (declared name: `superpowers-dev`) failed silently.
#
# These run on the HOST with no container and no Docker: the resolver is pure
# shell + jq over a JSON file, so it is extracted from entrypoint.sh and
# exercised directly against fixtures. That is deliberate -- the bash suite
# needs a built image and a live token, and a defect this cheap to pin should
# not be gated behind either.
#
# Extraction depends on `_resolve_marketplace_name()` starting at column 0 with
# its closing `}` at column 0. A self-check below fails loudly if the function
# can no longer be found, so a refactor that breaks extraction cannot silently
# turn these into no-ops.

_t98_extract_resolver() {
    local out="$1"
    sed -n '/^_resolve_marketplace_name() {$/,/^}$/p' "$REPO/entrypoint.sh" > "$out"
    [ -s "$out" ]
}

test_plugin_marketplace_name() {
    local PASS=0 FAIL=0
    local REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    local tmp; tmp="$(mktemp -d)"
    # NO `trap ... RETURN` here: bash fires a RETURN trap when a *sourced
    # script* finishes as well as when a function returns, so `source "$fn"`
    # below would delete $tmp mid-test. That bit on the first run, and it bit
    # INVISIBLY -- the fixture writes failed, the resolver read nothing, and
    # four "returns empty" assertions passed for entirely the wrong reason.
    # Hence the sentinels below, which fail if a fixture is not actually there.

    _ok()  { echo "  ok   $1"; PASS=$((PASS+1)); }
    _bad() { echo "  FAIL $1"; FAIL=$((FAIL+1)); }

    echo "--- #98 marketplace name resolution ---"

    # ── self-check: the function is still extractable ───────────────────────
    local fn="$tmp/resolver.sh"
    if _t98_extract_resolver "$fn"; then
        _ok "_resolve_marketplace_name() extracted from entrypoint.sh"
    else
        _bad "could not extract _resolve_marketplace_name() from entrypoint.sh — these tests would be vacuous"
        echo "  #98 marketplace name: $PASS passed, $FAIL failed"
        return 1
    fi

    # shellcheck disable=SC1090
    CLAUDE_CONFIG_DIR="$tmp/claude"; export CLAUDE_CONFIG_DIR
    mkdir -p "$CLAUDE_CONFIG_DIR/plugins"
    source "$fn"

    local km="$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"

    # ── the real-world payload that exposed the bug ─────────────────────────
    # Verbatim shape of Bear's known_marketplaces.json on 2026-11-09.
    cat > "$km" <<'JSON'
{
  "claude-plugins-official": {
    "source": { "source": "github", "repo": "anthropics/claude-plugins-official" },
    "installLocation": "/home/claude/.claude/plugins/marketplaces/claude-plugins-official"
  },
  "superpowers-dev": {
    "source": { "source": "github", "repo": "aberezin/superpowers" },
    "installLocation": "/home/claude/.claude/plugins/marketplaces/superpowers-dev"
  }
}
JSON

    # Sentinel: an "empty" result only means something if the file is there.
    if [ -s "$km" ]; then
        _ok "fixture known_marketplaces.json is present and non-empty"
    else
        _bad "fixture was never written ($km) — every 'empty' assertion below would be vacuous"
    fi

    local got
    got="$(_resolve_marketplace_name "aberezin/superpowers")"
    if [ "$got" = "superpowers-dev" ]; then
        _ok "aberezin/superpowers -> superpowers-dev (the case #96 got wrong)"
    else
        _bad "aberezin/superpowers resolved to '$got', expected 'superpowers-dev'"
    fi

    # The derivation this replaces would have produced "superpowers". Pin that
    # the resolver is genuinely reading the file rather than re-deriving.
    if [ "$got" != "superpowers" ]; then
        _ok "resolver does not reproduce the repo-slug derivation"
    else
        _bad "resolver returned the repo slug — it is not reading known_marketplaces.json"
    fi

    got="$(_resolve_marketplace_name "anthropics/claude-plugins-official")"
    if [ "$got" = "claude-plugins-official" ]; then
        _ok "the coincidental case still resolves (no regression for the default)"
    else
        _bad "anthropics/claude-plugins-official resolved to '$got'"
    fi

    # ── degradation: every failure mode must yield EMPTY, not garbage ───────
    # The caller falls back to the repo slug on empty, so "" is the contract.
    got="$(_resolve_marketplace_name "someone/never-added")"
    if [ -z "$got" ]; then
        _ok "unknown repo -> empty (caller falls back to the repo slug)"
    else
        _bad "unknown repo returned '$got', expected empty"
    fi

    echo '{ not valid json' > "$km"
    [ -s "$km" ] || _bad "could not write the malformed fixture — the next assertion is vacuous"
    got="$(_resolve_marketplace_name "aberezin/superpowers")"
    if [ -z "$got" ]; then
        _ok "malformed known_marketplaces.json -> empty, no crash"
    else
        _bad "malformed JSON returned '$got'"
    fi

    echo '{}' > "$km"
    got="$(_resolve_marketplace_name "aberezin/superpowers")"
    if [ -z "$got" ]; then
        _ok "empty object -> empty"
    else
        _bad "empty object returned '$got'"
    fi

    # An entry with no .source.repo at all must not match or explode.
    echo '{ "weird": { "installLocation": "/x" } }' > "$km"
    got="$(_resolve_marketplace_name "aberezin/superpowers")"
    if [ -z "$got" ]; then
        _ok "entry lacking .source.repo -> empty"
    else
        _bad "entry lacking .source.repo returned '$got'"
    fi

    rm -f "$km"
    [ -d "$(dirname "$km")" ] || _bad "the plugins dir vanished — the absent-file case is not testing what it claims"
    got="$(_resolve_marketplace_name "aberezin/superpowers")"
    if [ -z "$got" ]; then
        _ok "absent known_marketplaces.json -> empty (first-ever install)"
    else
        _bad "absent file returned '$got'"
    fi

    # ── the repo value reaches jq as DATA, never as program text ───────────
    # Shape validation upstream already forbids these characters, but this
    # path has a command-injection history (#96), so the defence is pinned
    # here rather than assumed from a caller two functions away.
    cat > "$km" <<'JSON'
{ "superpowers-dev": { "source": { "source": "github", "repo": "aberezin/superpowers" } } }
JSON
    got="$(_resolve_marketplace_name '"); $(touch '"$tmp"'/PWNED); ("')"
    if [ ! -e "$tmp/PWNED" ]; then
        _ok "a hostile repo string executes nothing (passed to jq via --arg)"
    else
        _bad "hostile repo string executed — jq is receiving it as program text"
    fi
    if [ -z "$got" ]; then
        _ok "hostile repo string also matches nothing"
    else
        _bad "hostile repo string matched '$got'"
    fi

    # ── structural: the entrypoint must CALL the resolver ──────────────────
    # A resolver nothing invokes is the shape of the original defect.
    if grep -q '_resolve_marketplace_name "\$marketplace_full"' "$REPO/entrypoint.sh"; then
        _ok "_install_project_plugins calls the resolver"
    else
        _bad "nothing calls _resolve_marketplace_name — the fix is dead code"
    fi

    # The two steps must be separate commands: the name cannot be known until
    # `marketplace add` has run, so a single chained `add && install` cannot
    # possibly use the resolved name.
    if grep -q "marketplace add '\$marketplace_full' && exec claude plugin install" "$REPO/entrypoint.sh"; then
        _bad "add and install are still chained — the resolved name cannot be used between them"
    else
        _ok "add and install are separate steps, so the name can be resolved between them"
    fi

    rm -rf "$tmp"
    echo "  #98 marketplace name: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_plugin_marketplace_name)

# Direct invocation (not sourced by test.sh) → run it now.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    test_plugin_marketplace_name
fi

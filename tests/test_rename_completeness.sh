#!/usr/bin/env bash
# tests/test_rename_completeness.sh — post-3.0-rebrand audit.
#
# Seven sweeps across the codebase looking for leftovers from the CLAUDEBOX_ →
# DRIDOCK_ rename that could silently break at 4.0's shim removal, or that
# already ship stale text to users. Each hit gets classified:
#
#   FAIL — a real bug (bare legacy read that breaks at 4.0, or wrong hardcoded
#          path). Exits non-zero when any are found.
#   WARN — docs debt or user-facing string still mentioning only the legacy
#          name. Doesn't break anything today, but should be tidied.
#   OK   — legitimate backward-compat construct (fallback pattern, alias
#          declaration, historical CHANGELOG entry, ADR docs describing the
#          rename). Not shown unless -v.
#
# NOT a test in the pass/fail sense — a diagnostic run. The complementary
# strict lint for cb-* helpers lives in test_env_rename_compat.sh (that one is
# a hard build-gate).
#
# Runs under `bash tests/test_rename_completeness.sh` OR via test.sh's glob
# (source-guard at top handles the latter cleanly).
[ "${BASH_SOURCE[0]}" != "${0}" ] && return 0 2>/dev/null

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR/.."
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

# Colors when a tty is attached; plain when piped/scripted.
if [ -t 1 ]; then
    C_FAIL=$'\e[31m'; C_WARN=$'\e[33m'; C_OK=$'\e[32m'; C_HDR=$'\e[1;36m'; C_RST=$'\e[0m'
else
    C_FAIL=''; C_WARN=''; C_OK=''; C_HDR=''; C_RST=''
fi

FAIL_COUNT=0 WARN_COUNT=0 OK_COUNT=0

hit()  {  # $1 = FAIL|WARN|OK, $2 = file:line, $3 = short description, $4 = raw line
    case "$1" in
        FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  %s[FAIL]%s %s: %s\n' "$C_FAIL" "$C_RST" "$2" "$3" ;;
        WARN) WARN_COUNT=$((WARN_COUNT + 1)); printf '  %s[WARN]%s %s: %s\n' "$C_WARN" "$C_RST" "$2" "$3" ;;
        OK)   OK_COUNT=$((OK_COUNT + 1)); [ "$VERBOSE" = 1 ] && printf '  %s[ok]%s   %s: %s\n' "$C_OK" "$C_RST" "$2" "$3" ;;
    esac
    [ -n "${4:-}" ] && [ "$VERBOSE" = 1 ] && printf '        %s\n' "$4"
}

header() { printf '\n%s── %s ──%s\n' "$C_HDR" "$1" "$C_RST"; }

# Files to scan: source code + docs, exclude generated, VCS, dependencies, and
# the deliberately-shadowed .claudebox/ historical dirs.
# Uses git ls-files if we're in a git repo (fast + respects .gitignore) with
# a find fallback for detached tree.
list_files() {
    if command -v git >/dev/null 2>&1 && git -C "$REPO" rev-parse >/dev/null 2>&1; then
        git -C "$REPO" ls-files
    else
        (cd "$REPO" && find . -type f \
            -not -path './.git/*' -not -path './node_modules/*' \
            -not -path './.claudebox/*' -not -path './.dridock/*' \
            -not -path './cb-browser-out/*' | sed 's|^\./||')
    fi
}

# Is this file DOCUMENTED to reference the old name (ADRs, CHANGELOG, migration
# docs)? Hits in these files are expected — surface only in verbose mode.
is_historical_doc() {
    case "$1" in
        CHANGELOG.md) return 0 ;;
        docs/design/3.0-migration.md) return 0 ;;
        docs/design/env-var-rename.md) return 0 ;;
        docs/design/features-system.md) return 0 ;;
        docs/design/profiles.md) return 0 ;;
        docs/design/upstream-sync.md) return 0 ;;   # discusses upstream psyb0t/docker-claudebox by name
        docs/design/framework-dev-mode.md) return 0 ;;
        docs/design/git-and-api-auth.md) return 0 ;;
        env-rename.map) return 0 ;;
        tests/test_rename_completeness.sh) return 0 ;;   # this script — its own grep patterns look like legacy hits
    esac
    return 1
}

# ── sweep 1: bare ${CLAUDEBOX_X:-…} reads without a ${DRIDOCK_X:-} sibling ──
# Same shape as the cb-* lint in test_env_rename_compat.sh, extended to every
# file in the tree. Cb-* files are exempted here (they have their own lint;
# reporting them twice is noise).
header "sweep 1: bare \${CLAUDEBOX_X:-…} reads (would break at 4.0)"
while IFS= read -r f; do
    case "$f" in
        cb-*|tests/test_env_rename_compat.sh) continue ;;   # own lint
    esac
    [ -f "$REPO/$f" ] || continue
    while IFS= read -r hit_line; do
        lineno="${hit_line%%:*}"
        content="${hit_line#*:}"
        # Positive: sibling ${DRIDOCK_ before the ${CLAUDEBOX_ on the same line
        has_sibling=$(printf '%s' "$content" | awk '
            { d = index($0, "${DRIDOCK_"); c = index($0, "${CLAUDEBOX_");
              print (d > 0 && d < c) ? "yes" : "no" }')
        # Positive: rename-map entry line: `_dridock_alias DRIDOCK_X CLAUDEBOX_X`
        is_alias_decl=$(printf '%s' "$content" | grep -qE '_dridock_alias\s+DRIDOCK_' && echo yes || echo no)
        # Positive: rename-map file column format
        is_map_pair=$([ "$f" = "env-rename.map" ] && echo yes || echo no)
        # Positive: comment-only lines are documentation of the compat, not reads
        stripped="$(printf '%s' "$content" | sed -e 's/^\s*//')"
        is_comment=$([ "${stripped:0:1}" = "#" ] && echo yes || echo no)
        if [ "$has_sibling" = yes ] || [ "$is_alias_decl" = yes ] || [ "$is_map_pair" = yes ] || [ "$is_comment" = yes ]; then
            hit OK "$f:$lineno" "backward-compat pattern"
        elif is_historical_doc "$f"; then
            hit OK "$f:$lineno" "historical doc (skipped)"
        else
            # Fail if it's source code, warn if it's a doc (users see the doc
            # but it doesn't actually break anything).
            case "$f" in
                *.md) hit WARN "$f:$lineno" "bare \${CLAUDEBOX_X:-} in prose — mention DRIDOCK_ too" "$content" ;;
                *)    hit FAIL "$f:$lineno" "bare \${CLAUDEBOX_X:-} read — will break at 4.0" "$content" ;;
            esac
        fi
    done < <(grep -nE '\$\{CLAUDEBOX_[A-Z_]+' "$REPO/$f" 2>/dev/null)
done < <(list_files)

# ── sweep 2: hardcoded .claudebox/ path refs (should route through cb_project_dot) ──
header "sweep 2: hardcoded .claudebox/ path refs (should use cb_project_dot or a .dridock/ sibling)"
while IFS= read -r f; do
    [ -f "$REPO/$f" ] || continue
    # Pre-compute: does the SAME FILE mention .dridock/ anywhere? If yes, adjacent-
    # line backward-compat (elif branches, paired gitignore lines, migration
    # string literals, help text describing what migration moves) is legit.
    file_has_dridock_ref=$(grep -qE '\.dridock/|cb_project_dot' "$REPO/$f" 2>/dev/null && echo yes || echo no)
    # Files whose PURPOSE is to touch legacy state: migration functions, migration
    # tests, wrapper's guard-workspace function. These legitimately reference the
    # legacy dotname without needing a same-line new counterpart.
    case "$f" in
        tests/test_cbconfig.sh)     legacy_touching=yes ;;
        wrapper.sh|entrypoint.sh)   legacy_touching=yes ;;   # both handle migration + backward-compat branches
        claudebox-shell.sh)         legacy_touching=yes ;;   # legacy filename kept; internal fallback branch
        .gitignore)                 legacy_touching=yes ;;   # paired dridock/claudebox entries by convention
        *)                          legacy_touching=no ;;
    esac
    while IFS= read -r hit_line; do
        lineno="${hit_line%%:*}"
        content="${hit_line#*:}"
        has_new=$(printf '%s' "$content" | grep -q '\.dridock/' && echo yes || echo no)
        uses_helper=$(printf '%s' "$content" | grep -qE 'cb_project_dot|_dotname' && echo yes || echo no)
        stripped="$(printf '%s' "$content" | sed -e 's/^\s*//')"
        is_comment=$([ "${stripped:0:1}" = "#" ] && echo yes || echo no)
        # elif / case arm — the "legacy branch" of a pair whose "if" already checked the new dir
        is_elif_or_case=$(printf '%s' "$content" | grep -qE '^\s*(elif |[^"]*\)\s*)' && echo yes || echo no)
        # String literal inside migration/output text (rmdir/moved/legacy/… on same line)
        is_migration_string=$(printf '%s' "$content" | grep -qE 'legacy|migrate|removed empty|→ \.dridock|-> \.dridock' && echo yes || echo no)
        # Help-text describing what migration moves from
        is_help_text=$(printf '%s' "$content" | grep -qE 'echo\s+"|printf .*[Mm]igrate' && echo yes || echo no)
        if [ "$has_new" = yes ] || [ "$uses_helper" = yes ] || [ "$is_comment" = yes ]; then
            hit OK "$f:$lineno" "same-line backward-compat/comment"
        elif [ "$legacy_touching" = yes ] && { [ "$is_elif_or_case" = yes ] || [ "$is_migration_string" = yes ] || [ "$file_has_dridock_ref" = yes ]; }; then
            hit OK "$f:$lineno" "legacy branch / migration string in legacy-aware file"
        elif is_historical_doc "$f"; then
            hit OK "$f:$lineno" "historical doc"
        else
            case "$f" in
                *.md) hit WARN "$f:$lineno" "bare .claudebox/ in prose — mention .dridock/ too" "$content" ;;
                *)    hit FAIL "$f:$lineno" "hardcoded .claudebox/ path — should use cb_project_dot" "$content" ;;
            esac
        fi
    done < <(grep -nE '\.claudebox/' "$REPO/$f" 2>/dev/null)
done < <(list_files)

# ── sweep 3: claudebox:latest image tag / bare `claudebox` binary in code ──
header "sweep 3: 'claudebox:latest' image tag / bare 'claudebox' binary refs (should be 'dridock')"
while IFS= read -r f; do
    [ -f "$REPO/$f" ] || continue
    # Image tag with :latest / :latest-minimal
    while IFS= read -r hit_line; do
        lineno="${hit_line%%:*}"
        content="${hit_line#*:}"
        has_new=$(printf '%s' "$content" | grep -q 'dridock:latest' && echo yes || echo no)
        stripped="$(printf '%s' "$content" | sed -e 's/^\s*//')"
        is_comment=$([ "${stripped:0:1}" = "#" ] && echo yes || echo no)
        if [ "$has_new" = yes ] || [ "$is_comment" = yes ] || is_historical_doc "$f"; then
            hit OK "$f:$lineno" "backward-compat/comment/historical"
        else
            case "$f" in
                *.md) hit WARN "$f:$lineno" "'claudebox:latest' in prose" "$content" ;;
                *)    hit FAIL "$f:$lineno" "'claudebox:latest' in code — should be dridock:latest" "$content" ;;
            esac
        fi
    done < <(grep -nE 'claudebox:latest' "$REPO/$f" 2>/dev/null)
done < <(list_files)

# ── sweep 4: XDG paths — ~/.config/claudebox, ~/.local/share/claudebox ──
header "sweep 4: XDG paths under claudebox/ (~/.config/claudebox, ~/.local/share/claudebox — should route through cb_xdg_dir)"
while IFS= read -r f; do
    [ -f "$REPO/$f" ] || continue
    # Same "legacy-touching file" pattern as sweep 2: files whose PURPOSE is to
    # handle migration or backward-compat routinely reference the legacy path.
    file_has_dridock_ref=$(grep -qE '(\.config/dridock|\.local/share/dridock|cb_xdg_dir)' "$REPO/$f" 2>/dev/null && echo yes || echo no)
    case "$f" in
        wrapper.sh|install.sh) legacy_touching=yes ;;   # migrate verb + install-time legacy handling
        *)                     legacy_touching=no ;;
    esac
    while IFS= read -r hit_line; do
        lineno="${hit_line%%:*}"
        content="${hit_line#*:}"
        has_new=$(printf '%s' "$content" | grep -qE '(\.config/dridock|\.local/share/dridock)' && echo yes || echo no)
        uses_helper=$(printf '%s' "$content" | grep -q 'cb_xdg_dir' && echo yes || echo no)
        stripped="$(printf '%s' "$content" | sed -e 's/^\s*//')"
        is_comment=$([ "${stripped:0:1}" = "#" ] && echo yes || echo no)
        is_migration_string=$(printf '%s' "$content" | grep -qE 'legacy|LEGACY|migrate' && echo yes || echo no)
        if [ "$has_new" = yes ] || [ "$uses_helper" = yes ] || [ "$is_comment" = yes ]; then
            hit OK "$f:$lineno" "same-line backward-compat/comment"
        elif [ "$legacy_touching" = yes ] && { [ "$is_migration_string" = yes ] || [ "$file_has_dridock_ref" = yes ]; }; then
            hit OK "$f:$lineno" "legacy path in legacy-aware file"
        elif is_historical_doc "$f"; then
            hit OK "$f:$lineno" "historical doc"
        else
            case "$f" in
                *.md) hit WARN "$f:$lineno" "bare XDG-claudebox path in prose" "$content" ;;
                *)    hit FAIL "$f:$lineno" "hardcoded XDG-claudebox path — should use cb_xdg_dir" "$content" ;;
            esac
        fi
    done < <(grep -nE '(\.config/claudebox|\.local/share/claudebox)' "$REPO/$f" 2>/dev/null)
done < <(list_files)

# ── sweep 5: ~/.claude/skills/claudebox/ skill dir refs (renamed to dridock/) ──
header "sweep 5: ~/.claude/skills/claudebox/ (renamed to skills/dridock/ in Phase 5)"
while IFS= read -r f; do
    [ -f "$REPO/$f" ] || continue
    while IFS= read -r hit_line; do
        lineno="${hit_line%%:*}"
        content="${hit_line#*:}"
        has_new=$(printf '%s' "$content" | grep -q 'skills/dridock' && echo yes || echo no)
        stripped="$(printf '%s' "$content" | sed -e 's/^\s*//')"
        is_comment=$([ "${stripped:0:1}" = "#" ] && echo yes || echo no)
        # legit legacy-removal case: the entrypoint deletes the old skill dir on boot
        is_removal=$(printf '%s' "$content" | grep -qE 'rm -rf.*skills/claudebox' && echo yes || echo no)
        if [ "$has_new" = yes ] || [ "$is_comment" = yes ] || [ "$is_removal" = yes ] || is_historical_doc "$f"; then
            hit OK "$f:$lineno" "backward-compat/comment/removal/historical"
        else
            case "$f" in
                *.md) hit WARN "$f:$lineno" "skills/claudebox/ in prose" "$content" ;;
                *)    hit FAIL "$f:$lineno" "skills/claudebox/ ref — should be skills/dridock/" "$content" ;;
            esac
        fi
    done < <(grep -nE '\.claude/skills/claudebox' "$REPO/$f" 2>/dev/null)
done < <(list_files)

# ── sweep 6: user-facing strings that mention only 'claudebox <verb>' ──────
# Look for the pattern `claudebox <verb>` in strings that users see (echo/print
# calls). Any hit where the SAME line doesn't also mention `dridock <verb>` is
# suspect. Broad — will surface both misses and legitimate historical mentions.
header "sweep 6: user-facing strings mentioning only 'claudebox <verb>' (docs debt)"
while IFS= read -r f; do
    [ -f "$REPO/$f" ] || continue
    # Same "legacy-touching file" pattern as sweep 2/4: files whose PURPOSE is to
    # handle the legacy name (elif branches, `command -v claudebox` fallbacks,
    # migration prose) can mention `claudebox <verb>` in a legacy arm without
    # needing a same-line new counterpart.
    file_has_dridock_ref=$(grep -qE 'dridock (bootstrap|start|migrate|features|checkversion|consult|net|ip|vm|info|profiles|auth|browser-bridge|host-agent|harness|framework-bugs|version|help|stop|down|destroy|setup-token|completion|clear-session|doctor|mcp|claude-dir|report-bug|df)|command -v dridock' "$REPO/$f" 2>/dev/null && echo yes || echo no)
    case "$f" in
        .claude/hooks/*|claudebox-shell.sh)            legacy_touching=yes ;;   # explicit if-dridock-elif-claudebox fallbacks
        docs/design/3.0-migration.md|docs/design/env-var-rename.md) legacy_touching=yes ;;   # migration standards
        *)                                             legacy_touching=no ;;
    esac
    while IFS= read -r hit_line; do
        lineno="${hit_line%%:*}"
        content="${hit_line#*:}"
        has_new=$(printf '%s' "$content" | grep -qE 'dridock (bootstrap|start|migrate|features|checkversion|consult|net|ip|vm|info|profiles|auth|browser-bridge|host-agent|harness|framework-bugs|version|help|stop|down|destroy|setup-token|completion|clear-session|--help|--version|-v|-h|doctor|mcp|claude-dir|report-bug|df)' && echo yes || echo no)
        stripped="$(printf '%s' "$content" | sed -e 's/^\s*//')"
        is_comment=$([ "${stripped:0:1}" = "#" ] && echo yes || echo no)
        # elif / case arm — the "legacy branch" of a pair whose "if" already checked the new name
        is_elif_or_case=$(printf '%s' "$content" | grep -qE '^\s*(elif |[^"]*\)\s*)' && echo yes || echo no)
        # Migration prose that explicitly names both eras
        is_migration_string=$(printf '%s' "$content" | grep -qE 'In 2\.x|legacy|LEGACY|pre-3\.0|renamed|Rename|migrate|(→|->)\s*dridock' && echo yes || echo no)
        if [ "$has_new" = yes ] || [ "$is_comment" = yes ] || is_historical_doc "$f"; then
            hit OK "$f:$lineno" "backward-compat mention/comment/historical"
        elif [ "$legacy_touching" = yes ] && { [ "$is_elif_or_case" = yes ] || [ "$is_migration_string" = yes ] || [ "$file_has_dridock_ref" = yes ]; }; then
            hit OK "$f:$lineno" "legacy branch / migration string in legacy-aware file"
        else
            hit WARN "$f:$lineno" "mentions 'claudebox <verb>' only — should also mention 'dridock <verb>'" "$content"
        fi
    done < <(grep -nE 'claudebox (bootstrap|start|migrate|features|checkversion|consult|net|ip|vm|info|profiles|auth|browser-bridge|host-agent|harness|framework-bugs|version|help|stop|down|destroy|setup-token|completion|clear-session|--help|--version|-v|-h|doctor|mcp|claude-dir|report-bug)' "$REPO/$f" 2>/dev/null)
done < <(list_files)

# ── sweep 7: completeness of env-rename.map ────────────────────────────────
# Extract every ${DRIDOCK_X used in the codebase, and confirm each has a
# corresponding pair line in env-rename.map. Missing entries mean the shim
# doesn't cover them → any CLAUDEBOX_X the user sets for them silently
# doesn't reach the DRIDOCK_X read.
header "sweep 7: env-rename.map completeness (every \${DRIDOCK_X used has a map entry)"
MAP="$REPO/env-rename.map"
declare -A _map_new=()
if [ -r "$MAP" ]; then
    while IFS= read -r line; do
        case "$line" in ''|'#'*) continue ;; esac
        set -- $line
        [ $# -ge 2 ] && _map_new[$1]=1
    done < "$MAP"
fi
# Collect every ${DRIDOCK_X} name used
declare -A _used=()
while IFS= read -r name; do
    _used[$name]=1
done < <(
    while IFS= read -r f; do
        [ -f "$REPO/$f" ] || continue
        # Skip the map itself and CHANGELOG (historical mentions abound)
        case "$f" in env-rename.map|CHANGELOG.md) continue ;; esac
        grep -oE '\$\{DRIDOCK_[A-Z_]+' "$REPO/$f" 2>/dev/null | sed 's/^\${//'
    done < <(list_files) | sort -u
)
# What's used but not in the map? Some DRIDOCK_X vars are intentionally not
# renamed-from-CLAUDEBOX_ — newly introduced, prefix families the wrapper
# iterates directly, test fixtures, or docs-literal placeholders. Whitelist
# them so the WARN list is signal, not noise.
_exempt_map_check() {
    case "$1" in
        DRIDOCK_ENV_*)                     return 0 ;;  # arbitrary-name forwarding prefix
        DRIDOCK_MOUNT_*)                   return 0 ;;  # arbitrary-mount forwarding prefix
        DRIDOCK_TEST_[A-Z]*)               return 0 ;;  # test fixtures
        DRIDOCK_VERSION)                   return 0 ;;  # internal version constant
        DRIDOCK_IMAGE_VARIANT)             return 0 ;;  # baked image env, not user-set
        DRIDOCK_FRAMEWORK_DEV)             return 0 ;;  # alias-of-alias — legacy CLAUDEBOX_FRAMEWORK_DEV maps to DRIDOCK_HARNESS_DEV instead
        DRIDOCK_MODEGUARD_*)               return 0 ;;  # feature-introduced (modeguard); no legacy pair
        DRIDOCK_X)                         return 0 ;;  # ${DRIDOCK_X} literal in docs
        DRIDOCK_WORKSPACE_*|DRIDOCK_PROJECT_ROOT)  return 0 ;;  # future / internal
    esac
    return 1
}
_missing_from_map=0
for _name in "${!_used[@]}"; do
    _exempt_map_check "$_name" && continue
    if [ -z "${_map_new[$_name]+x}" ]; then
        _missing_from_map=$((_missing_from_map + 1))
        # Show one example location
        _example=$(
            while IFS= read -r f; do
                [ -f "$REPO/$f" ] || continue
                case "$f" in env-rename.map|CHANGELOG.md) continue ;; esac
                grep -nE "\\\$\\{$_name\\b" "$REPO/$f" 2>/dev/null | head -1 | sed "s|^|$f:|"
            done < <(list_files) | head -1
        )
        hit WARN "${_example:-<unknown>}" "\${$_name} used but no env-rename.map entry — either newly-introduced (fine) or a rename miss (bug)"
    fi
done
[ "$_missing_from_map" = 0 ] && printf '  %s[ok]%s   every \${DRIDOCK_X used in code has a pair in env-rename.map\n' "$C_OK" "$C_RST"

# ── summary ────────────────────────────────────────────────────────────────
printf '\n%s── summary ──%s\n' "$C_HDR" "$C_RST"
printf '  %s%d FAIL%s   (real bugs — would break at 4.0 or ship stale to users)\n' "$C_FAIL" "$FAIL_COUNT" "$C_RST"
printf '  %s%d WARN%s   (docs debt / user-facing strings — visible but shipping fine)\n' "$C_WARN" "$WARN_COUNT" "$C_RST"
printf '  %s%d ok%s     (backward-compat patterns / historical / comments — %s)\n' "$C_OK" "$OK_COUNT" "$C_RST" "$([ "$VERBOSE" = 1 ] && echo 'shown above' || echo 'hidden; re-run with -v to see')"
printf '\n'

[ "$FAIL_COUNT" -eq 0 ]

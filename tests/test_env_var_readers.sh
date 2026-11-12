#!/usr/bin/env bash
# Every DRIDOCK_* setting documented in docs/environment-variables.md must have
# a reader in shipped code (#110).
#
# WHY: the 4.0 TS port carried the env-var documentation forward but not all
# of the code that read it. Six documented settings did nothing for six
# months: DRIDOCK_IMAGE, _IMAGE_NAME and _MINIMAL (#109), then _CAFFEINATE,
# _NO_DRIFT_WARN and _ALLOW_NEW (#110). Nothing failed, because a setting
# nobody reads looks exactly like a setting that's set to its default.
#
# What counts as a reader is a READ, not a mention:
#   - TS (dridock-ts/src, *.test.* excluded): env.get("X") / .bool("X") /
#     .require("X") (EnvResolver adds the DRIDOCK_ prefix; if EnvResolver
#     grows another accessor, add it here or its settings go red), or
#     ["DRIDOCK_X"] / .DRIDOCK_X on an env record. A message string such as
#     "set DRIDOCK_X=1 to silence this" is not a reader. That's how a dead
#     setting would stay green.
#   - shell (entrypoint.sh, install.sh, cb-*, features/, .claude/hooks/,
#     .githooks/): $DRIDOCK_X or ${DRIDOCK_X...}.
#   - Makefile: $(DRIDOCK_X) or ${DRIDOCK_X}.
#   - Python daemons at the repo root: "DRIDOCK_X" as a string key.
# Test files never count; #109's three settings had test references and no
# runtime reader.
#
# The DRIDOCK_ENV_* / DRIDOCK_MOUNT_* families are read by prefix, so their
# documented instances are skipped and the prefix READ is checked instead:
# the prefix as a complete string literal in code, comments stripped.
#
# Not covered: the --help USEFUL ENV list staying in sync with the doc. That's
# a separate pairing, and this test doesn't check it.
#
# Known limit: a reader anywhere counts. A setting documented as a run-time
# setting but read only by install.sh passes, which is why DRIDOCK_IMAGE_NAME
# and DRIDOCK_MINIMAL stayed green before #109 (only DRIDOCK_IMAGE showed).
#
# Names that aren't settings are listed below with a reason, not
# pattern-matched away, so a new exclusion is a reviewed decision.
#
# No docker required: pure filesystem.

_EVR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

test_env_var_readers() {
local REPO="$_EVR_DIR/.."
local DOC="$REPO/docs/environment-variables.md"
local PASS=0 FAIL=0
ok()  { echo "  ok   $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }

echo "--- documented DRIDOCK_* settings have a reader ---"

# Doc-example placeholders: they stand for "your name here".
local PLACEHOLDERS=" DRIDOCK_X DRIDOCK_ENV_FOO DRIDOCK_ENV_MY_VAR DRIDOCK_MOUNT_1 DRIDOCK_MOUNT_2 DRIDOCK_MOUNT_DATA DRIDOCK_MOUNT_RO DRIDOCK_MOUNT_STUFF "

# Shipped files outside dridock-ts, by how they read env.
local SHELL_FILES=() f
for f in "$REPO/entrypoint.sh" "$REPO/install.sh" "$REPO"/cb-*; do [ -f "$f" ] && SHELL_FILES+=("$f"); done
while IFS= read -r f; do SHELL_FILES+=("$f"); done < <(find "$REPO/features" "$REPO/.claude/hooks" "$REPO/.githooks" -type f 2>/dev/null)
local PY_FILES=("$REPO"/*.py)
local TS_FILES=()
while IFS= read -r f; do TS_FILES+=("$f"); done < <(find "$REPO/dridock-ts/src" -name '*.ts' ! -name '*.test.ts' -type f)

has_reader() {
    local name="$1" short="${1#DRIDOCK_}"
    grep -qE "\.(get|bool|require)\(\"${short}\"|\[\"${name}\"\]|\.${name}\b" "${TS_FILES[@]}" && return 0
    grep -qE "\\\$\{?${name}\b" "${SHELL_FILES[@]}" && return 0
    grep -qE "\\\$[({]${name}[)}:]" "$REPO/Makefile" && return 0
    grep -qE "[\"']${name}[\"']" "${PY_FILES[@]}" && return 0
    return 1
}

local names dead=0 total=0 family=0 n
names="$(grep -ohE 'DRIDOCK_[A-Z0-9_]+' "$DOC" | sort -u)"
for n in $names; do
    case "$PLACEHOLDERS" in *" $n "*) continue ;; esac
    # Prefix families are mechanisms: DRIDOCK_ENV_GITHUB_TOKEN is read by the
    # DRIDOCK_ENV_ prefix reader, not by its own name. Checked once below.
    case "$n" in DRIDOCK_ENV_*|DRIDOCK_MOUNT_*) family=$((family + 1)); continue ;; esac
    total=$((total + 1))
    has_reader "$n" || { echo "    NO READER: $n (documented in docs/environment-variables.md)" >&2; dead=$((dead + 1)); }
done

if [ "$dead" -eq 0 ]; then
    ok "all $total documented settings have a reader"
else
    bad "$dead of $total documented settings have no reader in shipped code"
fi

# The two prefix families. A READ only: a description string or comment that
# names the prefix doesn't count (Arfy's #110 mutation: ENV_PREFIXES changed
# to ["NOPE_"] stayed green on a description string and two comments).
local p ts_code
ts_code="$(cat "${TS_FILES[@]}" | grep -vE '^[[:space:]]*(//|\*|/\*)')"
for p in DRIDOCK_ENV_ DRIDOCK_MOUNT_; do
    # The prefix as a whole string literal: a quote right after it. That's
    # the shape of both real readers (`["DRIDOCK_ENV_"]`, startsWith), works
    # across line breaks (a formatter splitting the array), and rejects the
    # decoys: `"DRIDOCK_ENV_* forwards…"` has `*` after the prefix, and
    # comments are already stripped (Arfy, #110 re-review).
    if grep -qE "[\"'\`]${p}[\"'\`]" <<<"$ts_code"; then
        ok "prefix family ${p}* has a reader (covers the documented instances)"
    else
        bad "prefix family ${p}* has no reader in dridock-ts/src"
    fi
done
echo "    ($family documented DRIDOCK_ENV_*/DRIDOCK_MOUNT_* names rely on those two prefix readers)"

echo "  env-var readers: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
}

ALL_TESTS+=(test_env_var_readers)

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    ALL_TESTS=()
    test_env_var_readers
fi

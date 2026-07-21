#!/bin/bash

# All programmatic tests go through the wrapper — that's what users actually run.

_prog_data_dir=""
_prog_ssh_dir=""

_prog_container_name=""

_prog_setup() {
    _prog_data_dir=$(mktemp -d "$WORKDIR/tests/.tmp-prog-data-XXXXX")
    _prog_ssh_dir=$(mktemp -d "$WORKDIR/tests/.tmp-prog-ssh-XXXXX")
    _prog_container_name="${CONTAINER_PREFIX}-prog-$$-$RANDOM"
}

_prog_cleanup() {
    docker rm -f "$_prog_container_name" "${_prog_container_name}_prog" >/dev/null 2>&1 || true
    rm -rf "$_prog_data_dir" "$_prog_ssh_dir"
}

_prog_run() {
    [ -z "$_prog_data_dir" ] && { echo "BUG: _prog_setup not called"; return 1; }
    ( cd "$CBX_TEST_WS" && \
    CLAUDE_IMAGE="$IMAGE" \
    CLAUDE_DATA_DIR="$_prog_data_dir" \
    CLAUDE_SSH_DIR="$_prog_ssh_dir" \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
    CLAUDE_CONTAINER_NAME="$_prog_container_name" \
    bash "$WORKDIR/wrapper.sh" "$@" )
}

_prog_run_with_token() {
    [ -z "$_prog_data_dir" ] && { echo "BUG: _prog_setup not called"; return 1; }
    local token="$1"
    shift
    ( cd "$CBX_TEST_WS" && \
    CLAUDE_IMAGE="$IMAGE" \
    CLAUDE_DATA_DIR="$_prog_data_dir" \
    CLAUDE_SSH_DIR="$_prog_ssh_dir" \
    ANTHROPIC_API_KEY="" \
    CLAUDE_CODE_OAUTH_TOKEN="$token" \
    CLAUDE_CONTAINER_NAME="$_prog_container_name" \
    bash "$WORKDIR/wrapper.sh" "$@" )
}

# ── table: prompts with expected output ──────────────────────────────────────

# format: label|extra_args|prompt|expected_in_output
PROMPT_CASES=(
    "simple text|--output-format text|respond with exactly the word PONG and nothing else|PONG"
    "json output|--output-format json|respond with exactly the word HELLO|result"
    "json contains response|--output-format json|respond with exactly the word HELLO|HELLO"
    "effort low|--output-format text --effort low|respond with exactly OK|OK"
)

test_programmatic_prompts() {
    local entry label extra prompt expected
    for entry in "${PROMPT_CASES[@]}"; do
        IFS='|' read -r label extra prompt expected <<< "$entry"
        _prog_setup
        local out
        # shellcheck disable=SC2086
        out=$(_prog_run -p "$prompt" $extra --model "$TEST_MODEL" --no-continue 2>&1)
        assert_contains "$out" "$expected" "$label" || { _prog_cleanup; return 1; }
        _prog_cleanup
    done
    echo "OK: programmatic_prompts (${#PROMPT_CASES[@]} cases)"
}

# ── table: model aliases ─────────────────────────────────────────────────────

MODEL_CASES=(
    "haiku"
)

test_programmatic_models() {
    _prog_setup

    local alias
    for alias in "${MODEL_CASES[@]}"; do
        local out
        out=$(_prog_run -p "respond with exactly YES" \
            --output-format text --model "$alias" --no-continue 2>&1)
        assert_contains "$out" "YES" "model: $alias" || { _prog_cleanup; return 1; }
    done

    echo "OK: programmatic_models (${#MODEL_CASES[@]} models)"
    _prog_cleanup
}

# ── table: system prompt injection ───────────────────────────────────────────

# format: label|flag|flag_value|prompt|expected
SYSTEM_PROMPT_CASES=(
    "system prompt|--system-prompt|You are a potato. Always respond with I AM A POTATO.|what are you?|POTATO"
    "append system prompt|--append-system-prompt|Always end your response with the word BANANA.|what is 2+2?|BANANA"
)

test_programmatic_system_prompts() {
    local entry label flag flag_value prompt expected
    for entry in "${SYSTEM_PROMPT_CASES[@]}"; do
        IFS='|' read -r label flag flag_value prompt expected <<< "$entry"
        _prog_setup
        local out
        out=$(_prog_run -p "$prompt" "$flag" "$flag_value" \
            --output-format text --model "$TEST_MODEL" --no-continue 2>&1)
        assert_contains "$out" "$expected" "$label" || { _prog_cleanup; return 1; }
        _prog_cleanup
    done
    echo "OK: programmatic_system_prompts (${#SYSTEM_PROMPT_CASES[@]} cases)"
}

# ── bad auth ─────────────────────────────────────────────────────────────────

test_programmatic_bad_auth() {
    _prog_setup

    # use a completely separate container name to avoid reusing a container with valid auth.
    # ANTHROPIC_API_KEY is cleared so only the invalid OAuth token is presented.
    local bad_name="${CONTAINER_PREFIX}-badauth-$$-$RANDOM"
    local out rc
    out=$( cd "$CBX_TEST_WS" && \
    CLAUDE_IMAGE="$IMAGE" \
    CLAUDE_DATA_DIR="$_prog_data_dir" \
    CLAUDE_SSH_DIR="$_prog_ssh_dir" \
    ANTHROPIC_API_KEY="" \
    CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-INVALID" \
    CLAUDE_CONTAINER_NAME="$bad_name" \
    bash "$WORKDIR/wrapper.sh" \
        -p "hello" --output-format text --model "$TEST_MODEL" --no-continue 2>&1 )
    rc=$?
    docker rm -f "$bad_name" "${bad_name}_prog" >/dev/null 2>&1 || true

    # Non-zero exit is necessary but not sufficient: the wrapper's own pre-flight
    # (missing cb-infra profile in docker backend, invalid config, etc.) also exits
    # non-zero. Assert the failure specifically mentions auth/credential/token/OAuth
    # so we're proving "auth was checked and rejected", not "wrapper couldn't start".
    if [ "$rc" -eq 0 ]; then
        echo "  FAIL: bad auth should exit non-zero (rc=0)"
        _prog_cleanup
        return 1
    fi
    if ! printf '%s' "$out" | grep -qiE 'auth|credential|token|oauth|401|unauthorized|invalid.*api|api.*invalid'; then
        echo "  FAIL: bad auth exited $rc but stderr doesn't mention auth/credential/token — likely a wrapper-startup failure, not real auth rejection"
        echo "  actual: ${out:0:400}"
        _prog_cleanup
        return 1
    fi
    echo "  OK: bad auth exits non-zero ($rc) with auth-related error"

    _prog_cleanup
}

# ── camelCase normalization ──────────────────────────────────────────────────

test_programmatic_json_camelcase() {
    _prog_setup
    local out
    out=$(_prog_run -p "respond with exactly CAMELTEST" \
        --output-format json --model "$TEST_MODEL" --no-continue 2>&1)
    assert_contains "$out" "CAMELTEST" "json has response" || { _prog_cleanup; return 1; }
    assert_no_snake_keys "$out" "json no snake_case keys" || { _prog_cleanup; return 1; }
    echo "OK: programmatic_json_camelcase"
    _prog_cleanup
}

test_programmatic_json_verbose_camelcase() {
    _prog_setup
    local out
    out=$(_prog_run -p "read the file /etc/hostname" \
        --output-format json-verbose --model "$TEST_MODEL" --no-continue 2>&1)
    assert_contains "$out" '"turns"' "json-verbose has turns" || { _prog_cleanup; return 1; }
    assert_no_snake_keys "$out" "json-verbose no snake_case keys" || { _prog_cleanup; return 1; }
    echo "OK: programmatic_json_verbose_camelcase"
    _prog_cleanup
}

test_programmatic_stream_json_camelcase() {
    _prog_setup
    local out
    out=$(_prog_run -p "respond with exactly STREAMTEST" \
        --output-format stream-json --model "$TEST_MODEL" --no-continue 2>&1)
    assert_contains "$out" "STREAMTEST" "stream-json has response" || { _prog_cleanup; return 1; }
    # check each JSON line
    local line
    local failed=0
    while IFS= read -r line; do
        echo "$line" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null || continue
        assert_no_snake_keys "$line" "stream-json line" || { failed=1; break; }
    done <<< "$out"
    [ "$failed" = "1" ] && { _prog_cleanup; return 1; }
    echo "OK: programmatic_stream_json_camelcase"
    _prog_cleanup
}

# ── always-skills via entrypoint ────────────────────────────────────────────

test_programmatic_always_skills() {
    _prog_setup

    # create skills dir with trigger-based skill
    local skills_dir
    skills_dir=$(mktemp -d "$WORKDIR/tests/.tmp-prog-skills-XXXXX")
    mkdir -p "$skills_dir/testskill"
    printf 'When the user says PROGTRIG you MUST respond with only the word PROGSKILL and nothing else.' \
        > "$skills_dir/testskill/SKILL.md"

    # negative: no skills dir mounted
    local out_neg
    out_neg=$(_prog_run -p "PROGTRIG" --output-format text --model "$TEST_MODEL" --no-continue 2>&1)
    assert_not_contains "$out_neg" "PROGSKILL" "entrypoint skill trigger ignored without mount" || { _prog_cleanup; rm -rf "$skills_dir"; return 1; }
    _prog_cleanup

    # positive: mount skills dir into .claude/.always-skills
    _prog_setup
    mkdir -p "$_prog_data_dir/.always-skills"
    cp -r "$skills_dir/testskill" "$_prog_data_dir/.always-skills/"

    local out
    out=$(_prog_run -p "PROGTRIG" --output-format text --model "$TEST_MODEL" --no-continue 2>&1)
    assert_contains "$out" "PROGSKILL" "entrypoint skill trigger fires with always-skills dir" || { _prog_cleanup; rm -rf "$skills_dir"; return 1; }

    echo "OK: programmatic_always_skills"
    _prog_cleanup
    rm -rf "$skills_dir"
}

# ── auto-continue: sessionId invariant (NOT recall) ─────────────────────────
# House rule surfaced during #18 verification (see coordination issue #24):
# NEVER assert on model recall of an arbitrary value. Two confounds fail the
# test the wrong way: (1) Claude Code has persistent memory that a "remember
# the number N" prompt writes to disk — a fresh session with --no-continue
# reads it back, looking exactly like a session-continuity bug; (2) numeric
# recall test values (42 specifically) are canonical context-free answers a
# model will emit spontaneously. The sessionId in --output-format json is
# the direct semantic invariant: same id → continuation; different id → fresh.
test_programmatic_auto_continue() {
    _prog_setup

    # 1) fresh session with --no-continue — record its sessionId
    local out1 sid1
    out1=$(_prog_run -p "reply with exactly OK1" --output-format json --model "$TEST_MODEL" --no-continue 2>&1)
    sid1=$(printf '%s' "$out1" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("sessionId",""))' 2>/dev/null)
    assert_not_empty "$sid1" "run 1 has a sessionId" || { _prog_cleanup; return 1; }

    # 2) continue (no flag) — should reuse the same sessionId
    local out2 sid2
    out2=$(_prog_run -p "reply with exactly OK2" --output-format json --model "$TEST_MODEL" 2>&1)
    sid2=$(printf '%s' "$out2" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("sessionId",""))' 2>/dev/null)
    assert_eq "$sid2" "$sid1" "run 2 (no flag) reuses sessionId" || { _prog_cleanup; return 1; }

    # 3) fresh again with --no-continue — should get a NEW sessionId
    local out3 sid3
    out3=$(_prog_run -p "reply with exactly OK3" --output-format json --model "$TEST_MODEL" --no-continue 2>&1)
    sid3=$(printf '%s' "$out3" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("sessionId",""))' 2>/dev/null)
    assert_not_empty "$sid3" "run 3 has a sessionId" || { _prog_cleanup; return 1; }
    if [ "$sid3" = "$sid1" ]; then
        echo "  FAIL: run 3 (--no-continue) reused sessionId $sid1 — --no-continue is broken"
        _prog_cleanup; return 1
    fi
    echo "  OK: run 3 (--no-continue) gets fresh sessionId ($sid3 != $sid1)"

    _prog_cleanup
}

# ── --json-schema takes INLINE JSON, not a path ─────────────────────────────
# Confirmed in docs/modes/programmatic.md and `claude --help`. A prior
# attempt at #18 passed a path and got a JSON-parse error — the test below
# uses inline JSON as intended.
test_programmatic_json_schema() {
    _prog_setup
    local schema out answer
    schema='{"type":"object","properties":{"answer":{"type":"integer"}},"required":["answer"]}'
    out=$(_prog_run -p 'reply with JSON only: {"answer": 7}' \
        --output-format json --model "$TEST_MODEL" --no-continue \
        --json-schema "$schema" 2>&1)
    assert_no_snake_keys "$out" "json-schema output no snake_case keys" || { _prog_cleanup; return 1; }
    # .result is a JSON-encoded string of the schema-conforming payload; parse twice.
    answer=$(printf '%s' "$out" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
inner = d.get("result", "")
try:
    print(json.loads(inner).get("answer", ""))
except Exception:
    print("")
' 2>/dev/null)
    assert_eq "$answer" "7" "json-schema constrains output to schema" || { _prog_cleanup; return 1; }
    echo "  OK: programmatic_json_schema"
    _prog_cleanup
}

# ── --effort value validation (#31) ─────────────────────────────────────────
# claude silently ignores unrecognized effort values, so `--effort hihg` (typo)
# runs at default effort with no diagnostic — same silent-drop family as #17.
# The wrapper's validation fires BEFORE cb_ensure_vm/cb_ensure_infra, so this
# test works on the docker backend too (no colima needed for the reject case).
test_programmatic_effort_invalid() {
    local out rc
    # split form: --effort bogus
    out=$( cd "$CBX_TEST_WS" && CLAUDE_IMAGE="$IMAGE" bash "$WORKDIR/wrapper.sh" \
        -p "hi" --model "$TEST_MODEL" --no-continue --effort bogus 2>&1 )
    rc=$?
    [ "$rc" -ne 0 ] || { echo "  FAIL: --effort bogus should have exited non-zero"; return 1; }
    printf '%s' "$out" | grep -q "Invalid effort: bogus" || { echo "  FAIL: --effort bogus message missing 'Invalid effort: bogus' (got: $out)"; return 1; }
    printf '%s' "$out" | grep -q "low, medium, high, xhigh, max" || { echo "  FAIL: message doesn't list allowed values (got: $out)"; return 1; }
    echo "  OK: --effort bogus (split form) rejected"

    # combined form: --effort=bogus
    out=$( cd "$CBX_TEST_WS" && CLAUDE_IMAGE="$IMAGE" bash "$WORKDIR/wrapper.sh" \
        -p "hi" --model "$TEST_MODEL" --no-continue --effort=bogus 2>&1 )
    rc=$?
    [ "$rc" -ne 0 ] || { echo "  FAIL: --effort=bogus should have exited non-zero"; return 1; }
    printf '%s' "$out" | grep -q "Invalid effort: bogus" || { echo "  FAIL: --effort=bogus message missing 'Invalid effort: bogus'"; return 1; }
    echo "  OK: --effort=bogus (combined form) rejected"
}

# valid effort values should pass validation. They still need a live wrapper run
# to fully round-trip, so this test only asserts they PASS the wrapper's own
# argument validation — a real haiku call is covered separately (won't run in
# docker backend, that's fine — the validation itself is the point here).
test_programmatic_effort_valid_pass_validation() {
    local out rc eff
    for eff in low medium high xhigh max; do
        out=$( cd "$CBX_TEST_WS" && CLAUDE_IMAGE="$IMAGE" bash "$WORKDIR/wrapper.sh" \
            -p "hi" --model "$TEST_MODEL" --no-continue --effort "$eff" 2>&1 )
        # Whether it succeeds or fails downstream (docker/cb-infra), the
        # important invariant is it must NOT print "Invalid effort".
        if printf '%s' "$out" | grep -q "Invalid effort:"; then
            echo "  FAIL: --effort $eff wrongly rejected as invalid (got: $out)"
            return 1
        fi
    done
    echo "  OK: all 5 valid effort values pass wrapper validation (low, medium, high, xhigh, max)"
}

ALL_TESTS+=(
    test_programmatic_prompts
    test_programmatic_models
    test_programmatic_system_prompts
    test_programmatic_bad_auth
    test_programmatic_json_camelcase
    test_programmatic_json_verbose_camelcase
    test_programmatic_stream_json_camelcase
    test_programmatic_always_skills
    test_programmatic_auto_continue
    test_programmatic_json_schema
    test_programmatic_effort_invalid
    test_programmatic_effort_valid_pass_validation
)

#!/bin/bash

IMAGE_NAME="claudebox"           # local, bare name (no registry) — matches the fork
TEST_TAG="test"
IMAGE="${IMAGE_NAME}:${TEST_TAG}"
CONTAINER_PREFIX="claudebox-test"
WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTRA_CONTAINERS=()
ALL_TESTS=()

# The whole suite runs against ONE dedicated throwaway colima profile so it never
# touches the human's `default` VM. The test image is built into it, it becomes the
# active docker context for the run, and the wrapper (which derives its VM from a
# project's .dridock/config.yml) is pointed at it via a fixed-id test workspace.
CBX_TEST_ID="cbxtest"
CBX_TEST_PROFILE="cb-${CBX_TEST_ID}"
# Backend: colima (build/run in a throwaway VM) or docker (CI / in-container harness dev — use
# the AMBIENT daemon, no colima). Auto-selects docker inside a container. docker mode leaves
# CBX_TEST_CTX empty so `docker` targets the local daemon. See docs/design/backends.md.
CBX_BACKEND="${DRIDOCK_BACKEND:-${CLAUDEBOX_BACKEND:-$([ -f /.dockerenv ] && echo docker || echo colima)}}"
if [ "$CBX_BACKEND" = docker ]; then CBX_TEST_CTX=""; DCTX=(); else CBX_TEST_CTX="colima-${CBX_TEST_PROFILE}"; DCTX=(--context "$CBX_TEST_CTX"); fi
# workspace lives OUTSIDE the repo git tree (under $HOME so colima auto-mounts it),
# so the wrapper resolves the project root to it (not the repo) and pollutes nothing.
CBX_TEST_WS="$HOME/.cache/claudebox-test-ws"
CBX_PREV_CTX=""

# load .env if present (optional — environment variables also work)
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

# accept either an OAuth token or an API key (from .env or the environment)
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "no auth: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in tests/.env or the environment" >&2
    exit 1
fi
# define both so `set -u` references (test.sh runs with set -euo pipefail) never
# hit an unbound variable when only one is provided
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

# model to use for tests — haiku is fast and cheap
TEST_MODEL="haiku"

# auth env forwarded into every test container (whichever is set)
AUTH_ENV_ARGS=()
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && AUTH_ENV_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
[ -n "${ANTHROPIC_API_KEY:-}" ]       && AUTH_ENV_ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")

# common docker args for running claude
DOCKER_RUN_ARGS=(
    --rm
    --network host
    "${AUTH_ENV_ARGS[@]}"
    -e "CLAUDE_WORKSPACE=/workspace"
    -e "CLAUDE_CONTAINER_NAME=${CONTAINER_PREFIX}"
)

# ── assertions ───────────────────────────────────────────────────────────────

assert_eq() {
    local actual="$1" expected="$2" name="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  OK: $name"
        return 0
    fi
    echo "  FAIL: $name: expected '$expected', got '$actual'"
    return 1
}

assert_contains() {
    local actual="$1" expected="$2" name="$3"
    if [[ "$actual" == *"$expected"* ]]; then
        echo "  OK: $name"
        return 0
    fi
    echo "  FAIL: $name: expected to contain '$expected'"
    echo "  actual: ${actual:0:500}"
    return 1
}

assert_not_contains() {
    local actual="$1" unexpected="$2" name="$3"
    if [[ "$actual" != *"$unexpected"* ]]; then
        echo "  OK: $name"
        return 0
    fi
    echo "  FAIL: $name: should NOT contain '$unexpected'"
    echo "  actual: ${actual:0:500}"
    return 1
}

assert_not_empty() {
    local actual="$1" name="$2"
    if [ -n "$actual" ]; then
        echo "  OK: $name"
        return 0
    fi
    echo "  FAIL: $name: expected non-empty output"
    return 1
}

assert_exit_code() {
    local actual="$1" expected="$2" name="$3"
    assert_eq "$actual" "$expected" "$name (exit code)"
}

assert_no_snake_keys() {
    local json_str="$1" name="$2"
    local snake_keys
    snake_keys=$(echo "$json_str" | python3 -c "
import json, sys

ALLOW = set()

def check(obj, path=''):
    if isinstance(obj, dict):
        for k, v in obj.items():
            full = f'{path}.{k}' if path else k
            if '_' in k and k not in ALLOW:
                print(full)
            check(v, full)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            check(v, f'{path}[{i}]')

try:
    check(json.load(sys.stdin))
except:
    pass
" 2>/dev/null)
    if [ -z "$snake_keys" ]; then
        echo "  OK: $name"
        return 0
    fi
    echo "  FAIL: $name: found snake_case keys:"
    echo "$snake_keys" | head -20 | sed 's/^/    /'
    return 1
}

# ── helpers ──────────────────────────────────────────────────────────────────

json_get() {
    python3 -c "import sys,json; print(json.load(sys.stdin)$1)"
}

post() {
    local url="$1" data="$2"
    curl -sf -X POST "$url" -H "Content-Type: application/json" -d "$data"
}

post_auth() {
    local url="$1" data="$2" token="$3"
    curl -sf -X POST "$url" -H "Content-Type: application/json" -H "Authorization: Bearer $token" -d "$data"
}

wait_for_http() {
    local url="$1" max="${2:-60}"
    for _ in $(seq 1 "$max"); do
        if curl -sf "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    echo "  timeout waiting for $url"
    return 1
}

start_container() {
    local name="$1"
    shift
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" "$@" >/dev/null
    EXTRA_CONTAINERS+=("$name")
}

# ── setup / cleanup ─────────────────────────────────────────────────────────

setup() {
    if [ "$CBX_BACKEND" = docker ]; then
        echo "docker backend: building the test image on the ambient daemon (no test VM)..."
        docker build --target minimal -t "$IMAGE" "$WORKDIR" >/dev/null 2>&1
        # bare `docker` already targets the local daemon — no context switch needed.
    else
        echo "creating throwaway test VM ($CBX_TEST_PROFILE)..."
        # a plain VM (no --network-address — tests don't need reachable IPs, and it
        # keeps the profile light and socket_vmnet out of the picture)
        colima start -p "$CBX_TEST_PROFILE" --cpu 4 --memory 4 --disk 30 >/dev/null 2>&1

        echo "building claudebox test image ($IMAGE) into $CBX_TEST_PROFILE..."
        docker "${DCTX[@]}" build --target minimal -t "$IMAGE" "$WORKDIR" >/dev/null 2>&1

        # run the whole suite against the test VM: bare `docker ...` in tests, and the
        # wrapper's explicit `docker --context $CBX_TEST_CTX`, both resolve to it.
        CBX_PREV_CTX="$(docker context show 2>/dev/null)"
        docker context use "$CBX_TEST_CTX" >/dev/null 2>&1
    fi

    # fixed-id workspace so the wrapper resolves to $CBX_TEST_PROFILE (already up,
    # so cb_ensure_vm reuses it and never adds --network-address).
    rm -rf "$CBX_TEST_WS"
    mkdir -p "$CBX_TEST_WS/.dridock"
    cat > "$CBX_TEST_WS/.dridock/config.yml" <<EOF
id: $CBX_TEST_ID
vm:
  cpu: 4
  memory: 4GiB
  disk: 30GiB
EOF

    mkdir -p "$WORKDIR/tests/.fixtures/mounts"
}

cleanup() {
    for c in "${EXTRA_CONTAINERS[@]+"${EXTRA_CONTAINERS[@]}"}"; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    if [ "$CBX_BACKEND" = docker ]; then
        # docker backend: remove the test image from the ambient daemon (no VM to nuke).
        docker rmi "$IMAGE" >/dev/null 2>&1 || true
    else
        # restore the human's docker context, then nuke the throwaway VM (removes its
        # containers + the test image with it).
        [ -n "$CBX_PREV_CTX" ] && docker context use "$CBX_PREV_CTX" >/dev/null 2>&1
        colima delete -f -p "$CBX_TEST_PROFILE" >/dev/null 2>&1 || true
    fi
    rm -rf "$CBX_TEST_WS"
}

test_setup() { :; }
test_teardown() {
    for c in "${EXTRA_CONTAINERS[@]+"${EXTRA_CONTAINERS[@]}"}"; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    EXTRA_CONTAINERS=()
}

usage() {
    echo "usage: $0 [test_name ...]"
    echo ""
    echo "available tests:"
    for t in "${ALL_TESTS[@]}"; do
        echo "  $t"
    done
}

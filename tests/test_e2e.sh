#!/bin/bash

# End-to-end integration tests for the DETERMINISTIC mechanics the todo-app demo
# relies on (the demo itself — claudebot autonomously building an app — lives in
# examples/todo-app and is intentionally NOT in CI: it's slow, costs tokens, and is
# non-deterministic). Here we guard the two repeatable things:
#   1. a workspace reached through a SYMLINKED path still mounts non-empty in the VM
#      (regression for the macOS /tmp -> /private/tmp mount bug)
#   2. a PUBLISHED workload (like the container claudebot spins up) is reachable from
#      the host
#
# Both run against the shared throwaway test VM from common.sh (cb-cbxtest).

WRAPPER="$WORKDIR/wrapper.sh"

# ── 1. workspace mounts non-empty through a symlinked path ───────────────────
# The test workspace lives under $HOME (colima mounts ~). We reach it THROUGH a
# /tmp symlink and drive the real wrapper: its `cd -P` must resolve to the physical
# path so the container bind-mount matches lima's share. Without the fix the
# workspace mounts empty inside the VM and claudebot can't read the file.
test_e2e_workspace_mount_symlink() {
    local marker link out data_dir ssh_dir cname
    marker="MOUNTOK_$$_${RANDOM}"
    printf '%s\n' "$marker" > "$CBX_TEST_WS/mount-check.txt"
    link="/tmp/cbx-symlink-$$-${RANDOM}"
    ln -sfn "$CBX_TEST_WS" "$link"
    data_dir="$(mktemp -d)"; ssh_dir="$(mktemp -d)"
    cname="${CONTAINER_PREFIX}-mnt-$$"

    # drive the wrapper from the SYMLINKED path; ask claudebot to cat a file that
    # only exists if the workspace mounted correctly
    out=$( cd "$link" && \
        CLAUDE_IMAGE="$IMAGE" \
        CLAUDE_DATA_DIR="$data_dir" \
        CLAUDE_SSH_DIR="$ssh_dir" \
        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
        CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
        CLAUDE_CONTAINER_NAME="$cname" \
        bash "$WRAPPER" -p --model "$TEST_MODEL" --no-continue \
            "Run this shell command: cat mount-check.txt — then reply with ONLY its exact contents." 2>&1 )

    rm -f "$link" "$CBX_TEST_WS/mount-check.txt"
    rm -rf "$data_dir" "$ssh_dir"
    docker rm -f "$cname" "${cname}_prog" >/dev/null 2>&1 || true

    assert_contains "$out" "$marker" "workspace mounts non-empty through a symlinked path (/tmp fix)"
}

# ── 2. a published workload is reachable from the host ───────────────────────
# Fixed static server (deterministic) published on the test VM; colima forwards the
# port to the Mac's localhost even without --network-address (which the test VM
# deliberately lacks). This is the same "publish a workload" shape claudebot uses.
test_e2e_workload_reachable() {
    local name port
    name="${CONTAINER_PREFIX}-workload-$$-${RANDOM}"
    port=$(( 18000 + (RANDOM % 2000) ))
    docker rm -f "$name" >/dev/null 2>&1 || true
    # python3 ships in the (minimal) image; serve its cwd as a trivial HTTP endpoint
    docker run -d --name "$name" -p "$port:$port" --entrypoint python3 "$IMAGE" \
        -m http.server "$port" --bind 0.0.0.0 >/dev/null 2>&1
    EXTRA_CONTAINERS+=("$name")

    if wait_for_http "http://localhost:$port/" 30; then
        echo "  OK: published workload reachable from host at localhost:$port"
        docker rm -f "$name" >/dev/null 2>&1 || true
        return 0
    fi
    echo "  FAIL: published workload not reachable at localhost:$port"
    docker logs "$name" > "$TEST_LOG_DIR/$name.log" 2>&1 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 1
}

# ── 3. upstream init.d hooks still fire exactly once on first container create ─
# The per-project-VM migration moved the .claude dir (now per-project) — verify the
# inherited feature still works: ~/.claude/init.d/*.sh runs ONCE when the container
# is created, and is SKIPPED on reuse (marker /var/run/claude-initialized lives in
# the container fs, which persists across docker start). The data dir lives under
# $HOME so the cbxtest VM mounts it and the hook's output round-trips to the host.
_e2e_prog_run() {   # $1=container $2=datadir $3=sshdir $4=prompt
    ( cd "$CBX_TEST_WS" && \
        CLAUDE_IMAGE="$IMAGE" CLAUDE_DATA_DIR="$2" CLAUDE_SSH_DIR="$3" \
        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
        CLAUDE_CONTAINER_NAME="$1" \
        bash "$WRAPPER" -p --model "$TEST_MODEL" --no-continue "$4" >/dev/null 2>&1 )
}

test_e2e_init_hook_runs_once() {
    local ddir sdir cname n
    ddir="$(mktemp -d "$WORKDIR/tests/.tmp-init-data-XXXXX")"
    sdir="$(mktemp -d "$WORKDIR/tests/.tmp-init-ssh-XXXXX")"
    cname="${CONTAINER_PREFIX}-inithook-$$"
    # an init hook that appends one line to a file in the (mounted) .claude data dir
    mkdir -p "$ddir/init.d"
    cat > "$ddir/init.d/00-fired.sh" <<'HOOK'
#!/bin/bash
echo "fired" >> /home/claude/.claude/init-fired.log
HOOK
    chmod +x "$ddir/init.d/00-fired.sh"

    _e2e_prog_run "$cname" "$ddir" "$sdir" "reply with the single word ok"   # create -> should fire
    _e2e_prog_run "$cname" "$ddir" "$sdir" "reply with the single word ok"   # reuse  -> should be skipped

    n="$(wc -l < "$ddir/init-fired.log" 2>/dev/null | tr -d ' ')"
    docker rm -f "$cname" "${cname}_prog" >/dev/null 2>&1 || true
    rm -rf "$ddir" "$sdir"
    assert_eq "${n:-0}" "1" "init.d hook fires exactly once (create then reuse)"
}

ALL_TESTS+=(
    test_e2e_workspace_mount_symlink
    test_e2e_workload_reachable
    test_e2e_init_hook_runs_once
)

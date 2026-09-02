#!/bin/bash

# ── table: entrypoint behaviors ──────────────────────────────────────────────

# format: label|docker_extra_args|entrypoint_override|command|expected_in_output
ENTRYPOINT_CASES=(
    "version|--entrypoint claude||--version|[0-9]"
    "debug mode|-e DEBUG=true -e CLAUDE_WORKSPACE=/workspace -e CLAUDE_CONTAINER_NAME=${CONTAINER_PREFIX}-debug|||\\[DEBUG"
)

test_entrypoint_behaviors() {
    local entry label docker_extra ep_override cmd expected
    for entry in "${ENTRYPOINT_CASES[@]}"; do
        IFS='|' read -r label docker_extra ep_override cmd expected <<< "$entry"

        local args=(--rm)
        # shellcheck disable=SC2206
        [ -n "$docker_extra" ] && args+=($docker_extra)
        [ -n "$ep_override" ] && args+=($ep_override)
        args+=("$IMAGE")
        [ -n "$cmd" ] && args+=($cmd)

        local out
        out=$(docker run "${args[@]}" 2>&1)
        if echo "$out" | grep -qE "$expected"; then
            echo "  OK: $label"
        else
            echo "  FAIL: $label: expected match for '$expected'"
            echo "  output: ${out:0:300}"
            return 1
        fi
    done
    echo "OK: entrypoint_behaviors (${#ENTRYPOINT_CASES[@]} cases)"
}

# ── UID/GID matching ─────────────────────────────────────────────────────────

# The point of the entrypoint's UID-matching (on Linux) is that files claude
# creates in your workspace land owned by YOU, not by root/1000. Under colima,
# virtiofs maps every container-side write back to the host user regardless of the
# in-container UID, so that invariant holds via the mount and UID-matching is a
# no-op. Assert the invariant that actually matters (host-side ownership) rather
# than the Linux-specific UID-matching mechanism. See docs/design/per-project-vm.md.
test_entrypoint_workspace_ownership() {
    local tmpdir host_uid owner
    tmpdir=$(mktemp -d "$WORKDIR/tests/.tmp-own-XXXXX")
    host_uid=$(id -u)

    if [ "$host_uid" = "0" ]; then
        echo "  SKIP: running as root, ownership check not meaningful"
        rm -rf "$tmpdir"
        return 0
    fi

    # This assertion is colima-specific. It expects a file created INSIDE the
    # container to come back owned by the host uid, which depends on colima's
    # UID reflection into the mount. On the `docker` backend (ambient daemon —
    # auto-selected inside a container, tests/common.sh) there is no such
    # reflection and the file comes back uid 0. That's correct behavior for that
    # backend, not a regression, so assert it only where it means something.
    # Found by Bear running the suite from inside his claudebot (#63).
    if [ "${CBX_BACKEND:-}" = "docker" ]; then
        echo "  SKIP: docker backend has no colima UID reflection — ownership check is colima-only"
        rm -rf "$tmpdir"
        return 0
    fi

    # a container process creates a file in the mounted workspace
    docker run --rm -v "$tmpdir:$tmpdir" \
        --entrypoint bash "$IMAGE" -c "touch '$tmpdir/made-in-container'" >/dev/null 2>&1

    if [ ! -f "$tmpdir/made-in-container" ]; then
        echo "  FAIL: container did not create the file in the mounted workspace"
        rm -rf "$tmpdir"
        return 1
    fi

    # it must come back owned by the host user on the host (ls -ln is portable
    # across BSD/GNU; stat's -f/-c differ by platform)
    owner=$(ls -ln "$tmpdir/made-in-container" | awk 'NR==1{print $3}')
    assert_eq "$owner" "$host_uid" "container-created file is owned by host user ($host_uid)"
    rm -rf "$tmpdir"
}

test_entrypoint_claude_md() {
    local out
    # Reads ~/.claude/CLAUDE.md, NOT /workspace/CLAUDE.md (#63). The "Available
    # Tools in This Container" listing is emitted into CLAUDE_MD_USER
    # (entrypoint.sh:89) — the user-memory framework guidance rewritten on every
    # boot. /workspace/CLAUDE.md is a different artifact (the per-project template
    # copy) and does not exist at all when no workspace is mounted, which is the
    # case here — so this asserted against an empty string and could only ever
    # report whatever claude happened to print. Same path as the system_hint test
    # below; the two are deliberately symmetric.
    #
    # `head -1` was also wrong: the marker is ~35 lines in, not on line 1.
    out=$(docker run --rm --entrypoint bash "$IMAGE" -c \
        '/opt/dridock/entrypoint.sh ls /dev/null 2>&1; cat /home/claude/.claude/CLAUDE.md 2>/dev/null' 2>&1)
    assert_contains "$out" "Available Tools" "CLAUDE.md generated with tool listing"
}

# ── system hint generation ───────────────────────────────────────────────────

test_entrypoint_system_hint() {
    local out
    out=$(docker run --rm --entrypoint bash "$IMAGE" -c \
        '/opt/dridock/entrypoint.sh ls /dev/null 2>&1; cat /home/claude/.claude/system-hint.txt 2>/dev/null' 2>&1)
    assert_contains "$out" "Docker container" "system hint generated"
}

# ── .claude.json config patching ─────────────────────────────────────────────

test_entrypoint_config_patching() {
    local out
    out=$(docker run --rm --entrypoint bash "$IMAGE" -c \
        '/opt/dridock/entrypoint.sh ls /dev/null 2>&1; cat /home/claude/.claude/.claude.json 2>/dev/null' 2>&1)
    assert_contains "$out" '"installMethod"' "config patched with installMethod" || return 1
    assert_contains "$out" '"native"' "installMethod set to native"
}

# ── init.d scripts ───────────────────────────────────────────────────────────

test_entrypoint_initd() {
    local img
    img=$(docker build -q -f - "$WORKDIR" <<'DEOF'
FROM dridock:test
RUN mkdir -p /home/claude/.claude/init.d && \
    printf '#!/bin/bash\necho INITRAN > /tmp/init-marker\n' > /home/claude/.claude/init.d/01-test.sh && \
    chmod +x /home/claude/.claude/init.d/01-test.sh
DEOF
    )

    # run entrypoint but check the marker file, not claude output
    local out
    out=$(docker run --rm --entrypoint bash "$img" -c \
        'bash /opt/dridock/entrypoint.sh echo done 2>&1; cat /tmp/init-marker 2>/dev/null' 2>&1)
    assert_contains "$out" "INITRAN" "init.d script executed"

    docker rmi -f "$img" >/dev/null 2>&1 || true
}

# ── auto --continue (first run tries --continue, falls back) ────────────────

test_entrypoint_auto_continue() {
    # on a fresh container with no previous session, --continue should fail
    # then the entrypoint falls back to running without --continue
    local out
    out=$(docker run --rm \
        -e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN" \
        -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
        -e "DRIDOCK_WORKSPACE=/workspace" \
        -e "DRIDOCK_CONTAINER_NAME=${CONTAINER_PREFIX}-autocont" \
        "$IMAGE" \
        -p "What is the capital of Norway? Answer with one word." --output-format text --model "$TEST_MODEL" 2>&1)
    assert_contains "$out" "Oslo" "auto-continue fallback works"
}


# #80 phase 2: the whole point of the dot mount — dotfiles an agent writes must
# survive the container being DESTROYED and replaced. Proved by hand during
# development; this is what keeps it proved. Without it the mount could regress
# to shadow-but-don't-persist and every test would still pass, because nothing
# else recreates a container and looks again.
test_entrypoint_dotfiles_survive_recreate() {
    local dot; dot=$(mktemp -d)
    # Container 1: seed skel into an empty dot dir, then write the exact files
    # #55 and #80 are about.
    docker run --rm --entrypoint bash -v "$dot:/home/claude" "$IMAGE" -c \
        '/opt/dridock/entrypoint.sh true >/dev/null 2>&1
         su claude -c "git config --global pull.rebase false" 2>/dev/null
         su claude -c "git config --global credential.helper fake-helper" 2>/dev/null
         su claude -c "echo agent-was-here > ~/.bash_history" 2>/dev/null' >/dev/null 2>&1

    # Container 1 is gone. A brand-new container, same dot dir.
    local out
    out=$(docker run --rm --entrypoint bash -v "$dot:/home/claude" "$IMAGE" -c \
        '/opt/dridock/entrypoint.sh true >/dev/null 2>&1
         su claude -c "git config --global --list" 2>/dev/null
         cat /home/claude/.bash_history 2>/dev/null
         test -f /home/claude/.inputrc && echo INPUTRC_SEEDED' 2>&1)
    rm -rf "$dot"

    assert_contains "$out" "credential.helper=fake-helper" "gh credential helper survives recreate (#55)"
    assert_contains "$out" "pull.rebase=false" "git config survives recreate"
    assert_contains "$out" "agent-was-here" "bash history survives recreate"
    assert_contains "$out" "INPUTRC_SEEDED" "skel seeded into the mounted \$HOME"
}

# The exclusions must SHADOW the $HOME bind, so a cache written in the container
# never reaches the host dot dir. If this regresses, ~/.npm silently starts
# syncing gigabytes across the VM boundary and installs just get slower — a
# symptom nobody would trace back to a mount.
test_entrypoint_dot_exclusions_shadow() {
    local dot vol; dot=$(mktemp -d); vol="dridock-test-excl-$$"
    docker run --rm --entrypoint bash -v "$dot:/home/claude" -v "$vol:/home/claude/.npm" "$IMAGE" -c \
        'echo cache-content > /home/claude/.npm/entry' >/dev/null 2>&1
    local leaked="no"
    [ -e "$dot/.npm/entry" ] && leaked="yes"
    local in_vol
    # --entrypoint: the image ENTRYPOINT would swallow `ls /x` as its own args.
    in_vol=$(docker run --rm --entrypoint ls -v "$vol:/x" "$IMAGE" /x 2>/dev/null)
    docker volume rm -f "$vol" >/dev/null 2>&1
    rm -rf "$dot"

    assert_eq "$leaked" "no" "excluded path does NOT leak onto the host dot dir"
    assert_contains "$in_vol" "entry" "excluded content lands in the named volume"
}

ALL_TESTS+=(
    test_entrypoint_behaviors
    test_entrypoint_claude_md
    test_entrypoint_workspace_ownership
    test_entrypoint_system_hint
    test_entrypoint_config_patching
    test_entrypoint_initd
    test_entrypoint_auto_continue
    test_entrypoint_dotfiles_survive_recreate
    test_entrypoint_dot_exclusions_shadow
)

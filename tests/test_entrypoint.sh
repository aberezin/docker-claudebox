#!/bin/bash

# ── table: entrypoint behaviors ──────────────────────────────────────────────

# format: label|docker_extra_args|entrypoint_override|command|expected_in_output
ENTRYPOINT_CASES=(
    "version|--entrypoint claude||--version|[0-9]"
    "debug mode (DRIDOCK_DEBUG=1, #130)|-e DRIDOCK_DEBUG=1 -e CLAUDE_WORKSPACE=/workspace -e CLAUDE_CONTAINER_NAME=${CONTAINER_PREFIX}-debug|||\\[DEBUG"
    "legacy DEBUG=true still works in 6.x, with the rename nudge (#130)|-e DEBUG=true -e CLAUDE_WORKSPACE=/workspace -e CLAUDE_CONTAINER_NAME=${CONTAINER_PREFIX}-debug2|||bare DEBUG stops working in 7.0.0"
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

# ── #141: uid matching says TRUTHFULLY what it did ───────────────────────────
#
# The ownership test above asserts the round-trip, deliberately not the uid
# mechanism, which is why nothing failed while the mechanism quietly stopped
# being a no-op (#141: a container lifetime read the workspace as 501 and
# remapped claude to it).
#
# This asserts the #141 CONTRACT: the entrypoint says what it did, and what it
# says is true. It deliberately does NOT assert which uid the mount presents.
#
# WHY (#149): it used to require `claude` = 1000 or a workspace reading 0 — "the
# documented colima no-op". That is a property of the ENVIRONMENT, which the
# entrypoint neither controls nor promises. 6.1.0's gate ran in a lifetime where
# the workspace read 501, so the check failed while the code did exactly what
# #141 specifies, and the release shipped with a known-red test. A test that is
# red in some lifetimes and green in others teaches everyone to read past red,
# which is the opposite of what the FAIL backstop (#144) is for.
#
# The mechanism itself IS pinned, for BOTH presentations, by the 13 docker-free
# cases in tests/test_entrypoint_uid_match.sh (stub mounts: "workspace reads as
# root -> skip is SAID", "workspace reads 501:20 -> claude matched to 501:20").
# So a live-colima assertion on one presentation added no coverage, only
# fragility. What only a live run can check is that the three numbers on the
# status line match what the container actually is — which is what this does.
#
# It prints both readings on every run, pass or warn (Bear's suggestion, #149),
# so the next run in a lifetime that presents root records a fresh-inode
# reading for #143 at no extra cost: the tmpdir below is created seconds
# earlier, so its reading is a fresh inode, and whether a fresh inode can read
# 0 in one lifetime and 501 in another is exactly what separates virtiofs
# attribute caching from the mount itself.
# >>> uid_line_contract (#149) -- tests/test_uid_line_contract.sh runs this block
# Given the container's combined output, check the #141 status line against what
# the container independently says it is. Echoes findings plus one parseable
# UIDLINE row; rc 1 when the line is untrue or unparseable.
#
# The workspace reading is BRACKETED, not compared across the run (Bear, #149
# review). On virtiofs the presented owner of a directory is not the host
# owner and moves when a guest process modifies it, so an `after` reading
# legitimately differs from what the entrypoint saw: his live run had the line
# say 0:0 and a later stat say 1000:1000, with neither wrong. WS0= is taken by
# the same uid in the same container immediately BEFORE the entrypoint runs,
# which is the closest observation to the moment it looked, so `said_ws` is
# held to that. WS= is taken after and only ever printed — it is the #143
# datum, and a WS0 != WS pair is itself a measurement of the mutation Bear
# found. Same idiom as CLAUDE.md's rule about diagnostics: capture a before
# watermark rather than compare against accumulated state.
#
# This is extracted and driven over synthetic outputs by
# tests/test_uid_line_contract.sh, because the live test below needs a docker
# daemon — and a checker can't be verified by the case where nothing is wrong
# (#144). The parse guard is the point: if the entrypoint's line format drifts,
# every sed below yields "" and a checker that only compared empty strings
# would pass everything. It fails loudly instead.
_uid_line_contract() {
    local out="$1" rc=0 line said_ws said_claude how before_ws real_ws real_claude
    line=$(printf '%s\n' "$out" | grep -m1 'dridock: uid: workspace reads') || line=""  # swallow-ok: a missing line is reported two lines down as a parse failure, with the rc
    said_ws=$(printf '%s\n' "$line" | sed -n 's/.*workspace reads \([0-9]*:[0-9]*\),.*/\1/p')
    said_claude=$(printf '%s\n' "$line" | sed -n 's/.*claude runs as \([0-9]*:[0-9]*\) .*/\1/p')
    how=$(printf '%s\n' "$line" | sed -n 's/.*claude runs as [0-9]*:[0-9]* (\([^)]*\)).*/\1/p')
    before_ws=$(printf '%s\n' "$out" | sed -n 's/^WS0=\([0-9]*:[0-9]*\)$/\1/p' | tail -1)
    real_ws=$(printf '%s\n' "$out" | sed -n 's/^WS=\([0-9]*:[0-9]*\) CLAUDE=.*/\1/p' | tail -1)
    real_claude=$(printf '%s\n' "$out" | sed -n 's/^WS=[0-9]*:[0-9]* CLAUDE=\([0-9]*:[0-9]*\)/\1/p' | tail -1)

    # On the record in EVERY outcome (#149, Bear's ask): the mounted dir was
    # created seconds earlier, so real_ws is a FRESH inode's reading. Whether a
    # fresh inode can read 0:0 in one lifetime and 501:* in another is what
    # separates virtiofs attribute caching from the mount itself (#143).
    echo "  uid: line says workspace=$said_ws claude=$said_claude how='$how'; container read workspace=$before_ws before / $real_ws after, claude=$real_claude"
    [ -n "$before_ws" ] && [ -n "$real_ws" ] && [ "$before_ws" != "$real_ws" ] \
        && echo "  datum (#143): the workspace's presented owner MOVED during this run, $before_ws -> $real_ws, with nothing chowning it"

    if [ -z "$said_ws" ] || [ -z "$said_claude" ] || [ -z "$how" ] || [ -z "$before_ws" ] || [ -z "$real_ws" ] || [ -z "$real_claude" ]; then
        echo "  FAIL: couldn't parse the uid line or the container's own reading (line='$line'): the checks below would assert nothing"
        echo "UIDLINE ws= claude= wsbefore= saidws= how="
        return 1
    fi
    [ "$said_claude" = "$real_claude" ] \
        || { echo "  FAIL: the line says claude runs as $said_claude, but id says $real_claude"; rc=1; }
    [ "$said_ws" = "$before_ws" ] \
        || { echo "  FAIL: the line says it read the workspace as $said_ws, but a stat by the same uid moments earlier said $before_ws"; rc=1; }
    # Internal consistency of the line, which holds whatever the mount presents.
    case "$how" in
        matched)
            [ "$said_claude" = "$said_ws" ] \
                || { echo "  FAIL: it says (matched) but reports claude as $said_claude against a workspace of $said_ws"; rc=1; } ;;
        "skipped: the workspace reads as root"*)
            case "$said_ws" in
                0:*|*:0) ;;
                *) echo "  FAIL: it says it skipped because the workspace reads as root, but reports reading $said_ws"; rc=1 ;;
            esac ;;
        # #147: on a share or an untrusted filesystem the match is skipped
        # whatever the workspace reads; the uid check above still holds it.
        "skipped: the workspace is a "*" share"*|"skipped: the workspace's filesystem"*) ;;
        *FAILED*) echo "  note: groupmod/usermod failed in this run and the line says so, which is the contract" ;;
        *) echo "  FAIL: unrecognised outcome '$how' on the uid line"; rc=1 ;;
    esac
    [ "$rc" -eq 0 ] && echo "  OK: the uid line is true — what it reports matches what the container is"
    # `how` goes LAST: it contains spaces, so any field after it would be
    # unparseable from the row.
    echo "UIDLINE ws=$real_ws claude=$real_claude wsbefore=$before_ws saidws=$said_ws how=$how"
    return "$rc"
}
# <<< uid_line_contract

test_entrypoint_uid_observable() {
    local tmpdir out rc=0 row real_claude said_ws how
    tmpdir=$(mktemp -d "$WORKDIR/tests/.tmp-uid-XXXXX")
    out=$(docker run --rm -e DRIDOCK_WORKSPACE="$tmpdir" -v "$tmpdir:$tmpdir" --entrypoint bash "$IMAGE" -c \
        'echo "WS0=$(stat -c %u:%g "$DRIDOCK_WORKSPACE")"; bash /opt/dridock/entrypoint.sh true 2>&1; echo "WS=$(stat -c %u:%g "$DRIDOCK_WORKSPACE") CLAUDE=$(id -u claude):$(id -g claude)"' 2>&1)
    rm -rf "$tmpdir"
    assert_contains "$out" "dridock: uid: workspace reads" "entrypoint states what the workspace read as and what claude runs as"

    local contract
    contract=$(_uid_line_contract "$out") || rc=1
    printf '%s\n' "$contract" | grep -v '^UIDLINE '   # swallow-ok: grep -v returns 1 only when every line is the UIDLINE row, which the parse-failure path already reported with its rc
    row=$(printf '%s\n' "$contract" | sed -n 's/^UIDLINE //p' | tail -1)
    real_claude=${row#*claude=}; real_claude=${real_claude%% *}
    said_ws=${row#*saidws=}; said_ws=${said_ws%% *}
    how=${row#*how=}

    # The ENVIRONMENT: reported, never asserted (#149). A remap under colima is
    # the #143 flip — loud here, not red, because the harness did its job. The
    # mechanism for BOTH presentations is pinned docker-free by
    # tests/test_entrypoint_uid_match.sh (13 cases), so asserting one
    # presentation here added no coverage, only a suite that went red in half
    # the container lifetimes while the code behaved exactly as specified.
    # Keyed on the OUTCOME, not on a reading (Bear, #149 review): keying it off
    # the after-reading announced "claude was remapped to 1000:1000" for a run
    # whose line said (skipped). A remap is exactly `how` = matched.
    if [[ "$(docker info --format '{{.Name}}' 2>/dev/null)" == colima* ]]; then
        case "$how" in
            matched) echo "  ⚠️  colima presented the workspace as $said_ws, so claude was remapped to $real_claude. The presented owner on virtiofs follows guest writes, not the host (#143); #147 reconciles the named volumes either way. NOT a failure — the entrypoint reported it correctly." ;;
            "skipped: the workspace reads as root"*) echo "  note: the workspace read as root ($said_ws), matching skipped" ;;
            skipped*) echo "  note: matching skipped by design on this filesystem (#147); the workspace happened to read $said_ws, which on virtiofs only says who last wrote to it (#143)" ;;
            "") echo "  note: no outcome to report (the contract check above failed)" ;;
            *) echo "  note: outcome '$how' — see the line above" ;;
        esac
    fi
    return "$rc"
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

# ── auto --continue (first run uses --continue; nothing to continue is rc 0) ──

test_entrypoint_auto_continue() {
    # on a fresh container with no previous session, --continue has nothing to
    # continue and exits 0 with a normal run. There is no `|| exec claude`
    # fallback any more (#128): it only ever hid real refusals.
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
    test_entrypoint_uid_observable
    test_entrypoint_system_hint
    test_entrypoint_config_patching
    test_entrypoint_initd
    test_entrypoint_auto_continue
    test_entrypoint_dotfiles_survive_recreate
    test_entrypoint_dot_exclusions_shadow
)

#!/bin/bash

# Tests install.sh's host-side logic with colima/docker/sudo STUBBED (option B).
# This exercises the parts that don't need a real colima VM: docker/colima
# presence checks, Dockerfile detection, ssh-key + ~/.claude creation, the
# no-sudo install into a user-writable dir, the PATH nudge, and that sudo is
# never invoked. See task: "Revisit test_install" for a real end-to-end test.

test_install_host_logic() {
    local tmp stub repo home instdir out rc pass m
    tmp=$(mktemp -d "$WORKDIR/tests/.tmp-install-XXXXX")
    stub="$tmp/stub-bin"; repo="$tmp/repo"; home="$tmp/home"; instdir="$tmp/bin"
    mkdir -p "$stub" "$repo" "$home" "$instdir"

    # stub colima + docker as no-ops that succeed; stub sudo to record if ever
    # called (and fail, so an unexpected sudo path is caught).
    printf '#!/bin/bash\nexit 0\n' > "$stub/colima"
    printf '#!/bin/bash\nexit 0\n' > "$stub/docker"
    cat > "$stub/sudo" <<EOF
#!/bin/bash
echo "SUDO_CALLED: \$*" >> "$tmp/sudo-called"
exit 1
EOF
    chmod 755 "$stub/colima" "$stub/docker" "$stub/sudo"

    # a minimal repo checkout: install.sh + wrapper.sh + a (dummy) Dockerfile
    cp "$WORKDIR/install.sh" "$repo/install.sh"
    cp "$WORKDIR/wrapper.sh" "$repo/wrapper.sh"
    echo "FROM scratch" > "$repo/Dockerfile"
    chmod 755 "$repo/install.sh" "$repo/wrapper.sh"

    # run install.sh with stubs first on PATH, a fresh HOME (no ssh-key prompt),
    # and a writable user install dir (so the no-sudo path is taken).
    out=$( cd "$repo" && PATH="$stub:$PATH" HOME="$home" \
        CLAUDEBOX_MINIMAL=1 CLAUDEBOX_INSTALL_DIR="$instdir" \
        bash ./install.sh 2>&1 )
    rc=$?

    pass=0

    # 1. wrapper installed (no sudo), executable, and is actually the wrapper
    if [ -x "$instdir/claudebox" ] && grep -q "cb_project_id" "$instdir/claudebox" 2>/dev/null; then
        echo "  OK: wrapper installed to \$CLAUDEBOX_INSTALL_DIR (no sudo)"
    else
        echo "  FAIL: wrapper not installed at $instdir/claudebox"; pass=1
    fi

    # 2. sudo was never invoked
    if [ ! -f "$tmp/sudo-called" ]; then
        echo "  OK: sudo never invoked"
    else
        echo "  FAIL: sudo was called: $(cat "$tmp/sudo-called")"; pass=1
    fi

    # 3. ssh key + ~/.claude created in the fresh HOME
    if [ -f "$home/.ssh/claudebox/id_ed25519" ] && [ -f "$home/.ssh/claudebox/id_ed25519.pub" ]; then
        echo "  OK: ssh keypair generated"
    else
        echo "  FAIL: ssh keypair missing"; pass=1
    fi
    [ -d "$home/.claude" ] && echo "  OK: ~/.claude created" || { echo "  FAIL: ~/.claude missing"; pass=1; }

    # 4. PATH nudge shown (instdir is not on PATH)
    if echo "$out" | grep -q "not on your PATH"; then
        echo "  OK: PATH nudge shown"
    else
        echo "  FAIL: no PATH nudge (out tail: ${out: -200})"; pass=1
    fi

    rm -rf "$tmp"
    if [ "$rc" -ne 0 ]; then
        echo "  FAIL: install.sh exited $rc"
        echo "$out" | tail -20 | sed 's/^/    /'
        return 1
    fi
    return "$pass"
}

ALL_TESTS+=(
    test_install_host_logic
)

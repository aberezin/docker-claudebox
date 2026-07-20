#!/usr/bin/env bash
# summary: install a git pre-commit hook that blocks accidental executable-bit strips (100755 → 100644)
# Idempotent. Refuses to overwrite a user-authored pre-commit hook (detected by
# our marker); print-and-exit-1 in that case. Silently skips if $DRIDOCK_WORKSPACE
# isn't a git repo yet — safe to enable before `git init`; the hook installs on
# the next `dridock` boot (installer is marker-guarded).
set -uo pipefail

WS="${DRIDOCK_WORKSPACE:-/workspace}"
HOOK="$WS/.git/hooks/pre-commit"
MARKER="# dridock-modeguard"

if [ ! -d "$WS/.git/hooks" ]; then
    echo "modeguard: $WS is not a git repo yet — will install on the next enable once .git/hooks exists" >&2
    exit 0
fi

if [ -f "$HOOK" ] && ! grep -qF "$MARKER" "$HOOK"; then
    echo "❌ modeguard: $HOOK already exists and wasn't installed by dridock." >&2
    echo "   Move/rename your existing hook, or fold this into it manually:" >&2
    echo "     git diff --cached --raw | awk '\$1==\":100755\" && \$2==\"100644\" {exit 1}'" >&2
    exit 1
fi

cat > "$HOOK" <<'HOOK'
#!/usr/bin/env bash
# dridock-modeguard — refuse commits that drop the file executable bit (100755 → 100644).
# The Edit/Write tool paths sometimes silently strip +x when writing over an
# executable file; this catches it before the mode-strip lands in a commit.
# Escape (intentional strip): DRIDOCK_MODEGUARD_ALLOW_MODE_STRIP=1 git commit ...
#                             OR: git commit --no-verify
set -u
[ "${DRIDOCK_MODEGUARD_ALLOW_MODE_STRIP:-}" = 1 ] && exit 0
_stripped="$(git diff --cached --raw 2>/dev/null | awk '$1==":100755" && $2=="100644" {print $NF}')"
if [ -n "$_stripped" ]; then
    echo "❌ dridock modeguard: files losing +x (100755 → 100644) in this commit:" >&2
    printf '   %s\n' $_stripped >&2
    echo "   Restore with:  chmod +x $_stripped && git add $_stripped" >&2
    echo "   If intentional:  DRIDOCK_MODEGUARD_ALLOW_MODE_STRIP=1 git commit ...  (or --no-verify)" >&2
    exit 1
fi
HOOK
chmod +x "$HOOK"
echo "modeguard: installed $HOOK"

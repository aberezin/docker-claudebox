#!/usr/bin/env bash
# Install every git hook this repo ships — and, with --check, report when an
# installed copy is missing, stale, or shadowed.
#
# WHY A SCRIPT (#104). `make hooks` was one `install -m 755 .githooks/pre-commit`
# line, which has three holes:
#
#   1. It names pre-commit explicitly, so a SECOND hook added later would need
#      someone to remember to add a line here too. Adding a hook and
#      distributing it were separate steps with nothing forcing the second —
#      the same shape as the unindexed-docs problem (tests/test_docs_index.sh).
#   2. It is a once-per-clone step, so it is a step people skip. Bear's clone had
#      only `.git/hooks/*.sample` on 2026-11-09, two months after CLAUDE.md
#      started requiring it: the master-commit guard was enforced in exactly one
#      of the two clones that commit to this repo.
#   3. Re-running it is also required whenever `.githooks/*` CHANGES
#      (CHANGELOG.md:65 says so for 5.4.0, and .githooks/pre-commit changed again
#      in 99633cf) and nothing detects that it hasn't been. A stale copy is the
#      worst state: installed, passing, and handing out advice the repo retracted.
#
# NOT core.hooksPath. Setting `core.hooksPath=.githooks` looks like it deletes
# this whole problem and does not: that path is inside the WORKTREE, so the hook
# is simply absent on any branch predating .githooks/ (437dc1c), and hooksPath
# REPLACES .git/hooks rather than supplementing it, so there is no fallback.
# .git/hooks/ lives outside the worktree and is branch-independent. Tested that
# way; the guard silently did nothing. See .githooks/pre-commit's header.
#
#   bash .githooks/install.sh            # install / refresh (idempotent)
#   bash .githooks/install.sh --check    # report only; silent + rc 0 when clean
set -uo pipefail

MODE=install
case "${1:-}" in
    ""|--install) MODE=install ;;
    --check)      MODE=check ;;
    -h|--help)    sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "install.sh: unknown argument '$1' (expected --install or --check)" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/.githooks"

# Every hook name git 2.56 recognises (githooks(5)). A whitelist rather than
# "install whatever is in the dir": a typo'd or mis-extensioned filename would
# otherwise be copied to a name git never calls, which is a silent no-op — the
# class CLAUDE.md forbids. Unknown names are REFUSED, loudly.
VALID_HOOKS="
applypatch-msg pre-applypatch post-applypatch
pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit
pre-rebase post-checkout post-merge pre-push
pre-receive update proc-receive post-receive post-update
reference-transaction push-to-checkout pre-auto-gc post-rewrite
sendemail-validate fsmonitor-watchman p4-changelist p4-prepare-changelist
p4-post-changelist p4-pre-submit post-index-change
"
_is_valid_hook() { case " $(echo $VALID_HOOKS) " in *" $1 "*) return 0 ;; esac; return 1; }

_problems=0
_say() { if [ "$MODE" = check ]; then echo "$1"; else echo "$1" >&2; fi; _problems=$((_problems + 1)); }

if [ ! -d "$SRC" ]; then
    _say "no .githooks/ directory at $SRC — nothing to install (is this the dridock repo?)"
    exit 1
fi

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    _say "$REPO is not a git worktree — cannot install hooks"
    exit 1
fi

# --- shadowing: a set core.hooksPath makes .git/hooks/ dead weight ------------
# `make hooks` would report success while installing a file git never runs. This
# is the one failure mode with no other symptom, so it is checked first and in
# both modes.
_hp="$(git -C "$REPO" config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$_hp" ]; then
    _scope=unknown
    if [ -n "$(git -C "$REPO" config --local --get core.hooksPath 2>/dev/null || true)" ]; then
        _scope="this repo (.git/config)"
    elif [ -n "$(git -C "$REPO" config --global --get core.hooksPath 2>/dev/null || true)" ]; then
        _scope="GLOBAL (~/.gitconfig — affects every repo you own)"
    fi
    _say "core.hooksPath is set to '$_hp' in $_scope, which REPLACES .git/hooks/ —
    anything installed there is never run. Unset it for this repo with:
        git -C $REPO config --unset core.hooksPath
    (and \`--global --unset\` if the scope above says global)."
fi

HOOKS_DIR="$(git -C "$REPO" rev-parse --git-common-dir)"
case "$HOOKS_DIR" in /*) ;; *) HOOKS_DIR="$REPO/$HOOKS_DIR" ;; esac
HOOKS_DIR="$HOOKS_DIR/hooks"

# --- the hooks themselves ----------------------------------------------------
_found=0 _installed=0 _refreshed=0
for f in "$SRC"/*; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"

    # Tooling lives beside the hooks; git hook names never carry an extension,
    # so `*.sh` is the rule that separates them (this file is .sh for exactly
    # that reason). But `pre-push.sh` is a MISTAKE, not tooling — a hook named
    # out of shell habit would otherwise be skipped in silence.
    case "$b" in
        *.sh)
            if _is_valid_hook "${b%.sh}"; then
                _say "$b is a git hook name with a .sh extension — git will never call it.
    Rename it to '${b%.sh}' (git hook names carry no extension)."
            fi
            continue ;;
    esac

    if ! _is_valid_hook "$b"; then
        _say ".githooks/$b is not a name git recognises as a hook, so copying it
    would be a silent no-op. Fix the name (see githooks(5)) or move the file out
    of .githooks/."
        continue
    fi

    _found=$((_found + 1))
    dest="$HOOKS_DIR/$b"
    if cmp -s "$f" "$dest" 2>/dev/null; then
        [ "$MODE" = install ] && echo "   = $b already current"
        continue
    fi
    if [ "$MODE" = check ]; then
        if [ -e "$dest" ]; then
            _say "$dest is STALE — it differs from the tracked .githooks/$b"
            _refreshed=$((_refreshed + 1))
        else
            _say "$dest is MISSING — the hook this repo ships is not installed"
            _installed=$((_installed + 1))
        fi
        continue
    fi
    mkdir -p "$HOOKS_DIR"
    if [ -e "$dest" ]; then _refreshed=$((_refreshed + 1)); else _installed=$((_installed + 1)); fi
    install -m 755 "$f" "$dest" || { _say "failed to install $b into $HOOKS_DIR"; continue; }
    echo "   + $b installed into $HOOKS_DIR"
done

# Sentinel: "0 problems" means nothing if the loop never saw a hook. An empty
# .githooks/ (or a glob that matched nothing) must not read as success.
if [ "$_found" -eq 0 ]; then
    _say "found no installable hooks in $SRC — this script reported success without doing anything"
fi

if [ "$MODE" = check ]; then
    [ "$_problems" -eq 0 ] && exit 0
    exit 1
fi

if [ "$_problems" -gt 0 ]; then
    echo "⚠️  git hooks: $_problems problem(s) above — the guard may not be active." >&2
    exit 1
fi
echo "✅ git hooks up to date in $HOOKS_DIR ($_found shipped, $_installed new, $_refreshed refreshed)"
exit 0

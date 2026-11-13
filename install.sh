#!/usr/bin/env bash

# ── flags ────────────────────────────────────────────────────────────────────
# BIN_NAME stays POSITIONAL for backwards compat (`./install.sh myname`), so
# flags are stripped out first and the positional args put back.
CLAUDE_VERSION_OVERRIDE=""
_rest=()
while [ $# -gt 0 ]; do
	case "$1" in
		--claude-version)   CLAUDE_VERSION_OVERRIDE="${2:-}"; shift 2 || shift ;;
		--claude-version=*) CLAUDE_VERSION_OVERRIDE="${1#*=}"; shift ;;
		-h|--help)
			cat <<'USAGE'
usage: ./install.sh [BIN_NAME] [--claude-version <v>|latest|stable]

  BIN_NAME              install the host binary under this name (default: dridock)
  --claude-version <v>  build the image with this Claude Code CLI version,
                        overriding the Dockerfile's ARG CLAUDE_VERSION pin.
                        `latest` / `stable` are RESOLVED to a concrete version
                        here and the number is what gets built, so the build
                        stays reproducible and Docker's layer cache still busts
                        (the literal string `latest` never changes, so passing
                        it through would silently reuse a stale cached CLI).

⚠️  Raising the CLI floor is not purely mechanical. Claude Code SILENTLY IGNORES
    unknown flags (exit 0, no warning — see #17), so a too-old pin accepts
    feature flags dridock forwards and drops them without complaint. When you
    raise it, re-check the entrypoint's `--remote-control` capability probe.
    Run `dridock checkversion` afterwards to confirm what landed.
USAGE
			exit 0 ;;
		*) _rest+=("$1"); shift ;;
	esac
done
set -- "${_rest[@]+"${_rest[@]}"}"

# ── resolve latest/stable to a concrete version ──────────────────────────────
# Passing the literal `latest` to the Dockerfile ARG would be a silent trap: the
# ARG VALUE is what busts Docker's layer cache, and `latest` is a string that
# never changes — so the CLI layer would be reused indefinitely and you'd get a
# stale CLI while believing you'd asked for the newest. Resolve it up front, and
# fail loudly rather than falling back to a guess (repo rule: never silently
# discard user-supplied input).
DRIDOCK_CLAUDE_RELEASES_URL="${DRIDOCK_CLAUDE_RELEASES_URL:-https://downloads.claude.ai/claude-code-releases}"
case "$CLAUDE_VERSION_OVERRIDE" in
	latest|stable)
		_channel="$CLAUDE_VERSION_OVERRIDE"
		_resolved=$(curl -fsSL --max-time 20 "$DRIDOCK_CLAUDE_RELEASES_URL/$_channel" 2>/dev/null | head -1 | tr -d '\r')
		if [ -z "$_resolved" ]; then
			echo "install.sh: could not reach $DRIDOCK_CLAUDE_RELEASES_URL/$_channel to resolve '$_channel'." >&2
			echo "            Pass an explicit version instead: --claude-version 2.1.243" >&2
			exit 1
		fi
		# Reject anything that isn't a version (an HTML error page, a redirect
		# notice) before it becomes a build arg.
		if ! printf '%s' "$_resolved" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[^[:space:]]+)?$'; then
			echo "install.sh: '$_channel' resolved to something that is not a version: $_resolved" >&2
			exit 1
		fi
		echo "==> claude CLI: $_channel resolves to $_resolved (pinning that, not '$_channel')"
		CLAUDE_VERSION_OVERRIDE="$_resolved"
		;;
esac

# The override applies to THIS BUILD ONLY -- it never writes the Dockerfile's
# `ARG CLAUDE_VERSION`. So an account built with the flag diverges from the
# committed default, and the next bare `./install.sh` (here or in another
# account) silently rebuilds on the OLDER CLI.
#
# That is not a cosmetic drift. claude SILENTLY IGNORES unknown flags (#17):
# a too-old CLI accepts the flags dridock forwards and drops them, exit 0, no
# warning. "Older than intended" never announces itself.
#
# Happened for real on 2026-09-02: Bear was rebuilt at 2.1.258 while the pin
# still said 2.1.215, and nothing anywhere said so.
if [ -n "$CLAUDE_VERSION_OVERRIDE" ]; then
	# NB: SCRIPT_DIR is not defined this early in the script, so resolve the
	# Dockerfile independently. Using it here would read a nonexistent path,
	# leave _pin empty, and make this warning silently never fire -- which is
	# the exact failure class it exists to catch.
	_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
	_pin="$(sed -n 's/^ARG CLAUDE_VERSION=\([^ ]*\).*/\1/p' "$_here/Dockerfile" 2>/dev/null | head -1)"
	if [ -n "$_pin" ] && [ "$_pin" != "$CLAUDE_VERSION_OVERRIDE" ]; then
		echo ""
		echo "⚠️  --claude-version $CLAUDE_VERSION_OVERRIDE does NOT update the committed pin"
		echo "    (Dockerfile: ARG CLAUDE_VERSION=$_pin). This build gets $CLAUDE_VERSION_OVERRIDE;"
		echo "    the NEXT bare './install.sh' -- here or in another account -- gets $_pin."
		echo "    claude ignores unknown flags silently (#17), so that regression is invisible."
		echo ""
		echo "    To make it stick, commit the pin:"
		echo "        ARG CLAUDE_VERSION=$CLAUDE_VERSION_OVERRIDE"
		echo ""
	fi
fi

BIN_NAME="${1:-${DRIDOCK_BIN_NAME:-dridock}}"
# Default to a user-writable dir so install needs no sudo (this fork avoids macOS
# sudo). Override with DRIDOCK_INSTALL_DIR
# still accepted for one deprecation cycle).
INSTALL_DIR="${DRIDOCK_INSTALL_DIR:-$HOME/.local/bin}"
BIN_PATH="$INSTALL_DIR/$BIN_NAME"

echo "🚀 Starting dridock setup (binary: $BIN_NAME)..."

# Check for Docker + Colima (this fork runs under colima with per-project VMs)
if ! command -v docker &>/dev/null; then
	echo "❌ Docker is not installed. Please install Docker first."
	exit 1
fi
if ! command -v colima &>/dev/null; then
	echo "❌ Colima is not installed. This fork builds and runs under colima."
	echo "   Install it (e.g. 'brew install colima') and retry."
	exit 1
fi

# Bun is required — the wrapper is now a bun-compiled TypeScript binary as of 4.0.0.
# (Pre-4.0.0 shipped a bash `wrapper.sh` as the default and TS was opt-in via
# DRIDOCK_INSTALL_TS=1. See CHANGELOG for 4.0.0 for the retirement + rollback path.)
if ! command -v bun >/dev/null 2>&1; then
	echo "❌ bun is not installed — required to build the dridock binary from source."
	echo "   Install it (https://bun.sh — curl -fsSL https://bun.sh/install | bash) and re-run install.sh."
	exit 1
fi

echo "📁 Creating ~/.claude directory..."
mkdir -p ~/.claude

echo "🔐 Creating SSH directory for Claude Code..."
mkdir -p "$HOME/.ssh/claudebox"

if [ -f "$HOME/.ssh/claudebox/id_ed25519" ]; then
	echo "🔑 SSH key already exists at $HOME/.ssh/claudebox/id_ed25519"
	read -rp "   Replace existing key? [y/N] " response
	if [[ "$response" =~ ^[Yy]$ ]]; then
		echo "🗝️ Generating new SSH key for Claude..."
		ssh-keygen -t ed25519 -C "claude@claude.ai" -f "$HOME/.ssh/claudebox/id_ed25519" -N ""
	else
		echo "   Keeping existing key."
	fi
else
	echo "🗝️ Generating SSH key for Claude..."
	ssh-keygen -t ed25519 -C "claude@claude.ai" -f "$HOME/.ssh/claudebox/id_ed25519" -N ""
fi

# This fork builds the image LOCALLY and never pulls from a registry. It must be
# run from a checkout of the repo (the Dockerfile and dridock-ts/ live next to it).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd)"

IMAGE_NAME="${DRIDOCK_IMAGE_NAME:-dridock}"

if [ ! -f "$SCRIPT_DIR/Dockerfile" ]; then
	echo "❌ Dockerfile not found in $SCRIPT_DIR."
	echo "   This fork builds a local image and does not pull from Docker Hub —"
	echo "   run install.sh from a checkout of the repo, not piped from curl."
	exit 1
fi

if [ ! -d "$SCRIPT_DIR/dridock-ts" ]; then
	echo "❌ dridock-ts/ not found in $SCRIPT_DIR — is this a valid dridock checkout?"
	exit 1
fi

# ── git hooks (#104) ─────────────────────────────────────────────────────────
# CLAUDE.md has required `make hooks` once per clone since 2026-09-01, and it is
# a step people skip: on 2026-11-09 the checkout at
# `~aberezin/.../docker-out-of-docker/docker-claudebox` on this host still held
# only `.git/hooks/*.sample`, so the master-commit guard this repo documents as
# ENFORCED was absent from a live checkout of it. install.sh is the command
# everyone actually runs, so the guard rides along with it.
#
# Deliberately BEFORE the image build: the build takes minutes and can fail, and
# a hook that only lands on a successful build is a hook that doesn't land.
# Non-fatal — a missing hook must not stop someone installing the harness — but
# it says so out loud rather than skipping in silence (CLAUDE.md house rule).
if [ -f "$SCRIPT_DIR/.githooks/install.sh" ] && git -C "$SCRIPT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
	echo "🪝 Installing this repo's git hooks..."
	if ! bash "$SCRIPT_DIR/.githooks/install.sh"; then
		echo "⚠️  git hook install reported problems (above). Continuing the install —"
		echo "    but the pre-commit guard may not be active in this clone."
	fi
fi

# >>> install_clear_unreadable (#114) -- tests/test_install_unreadable_guard.sh runs this block
# A file or directory the current user can't read anywhere in the checkout fails
# the docker build on macOS with "failed to xattr …: permission denied", and
# .dockerignore can't prevent it: the sender lists each entry's xattrs, which on
# macOS needs read permission, before the ignore patterns apply. (Linux doesn't
# need it, which is why no container-side check saw this.) `bun build --compile`
# run in the container leaves exactly such files, mode 000, in dridock-ts/. One
# broke ./install.sh on 2026-11-12 (#114).
#
# Known temp shapes (*.bun-build files) are removed, each one named. Anything
# else unreadable is NOT deleted: it might be the user's (a locked file, a
# root-owned file a container left), so the install stops and names it. That
# includes directories: never rm -rf a directory we don't recognise.
#
# Readability is tested with [ -r ] (and [ -x ] for a directory, which the
# walk must enter), not a mode bit: a mode-600 file owned by someone else has
# u+r and is still unreadable to us. find's own errors (a directory it couldn't
# enter) are reported, not discarded: they are the guard's blind spots.
#
# Deliberately stricter than the build: .dockerignore's directory excludes
# (tests/, base/, …) prune the sender's walk, so an unreadable file under one
# wouldn't break the build, but it stops the install here. That's on purpose;
# the guard doesn't try to replicate .dockerignore. .git is skipped.
#   install_clear_unreadable <dir>   rc 1 when something unreadable remains
install_clear_unreadable() {
	local dir="$1" f rc=0 err
	err="$(mktemp)" || { echo "❌ install_clear_unreadable: mktemp failed" >&2; return 1; }
	while IFS= read -r f; do
		if [ -d "$f" ]; then
			[ -r "$f" ] && [ -x "$f" ] && continue
			echo "❌ $f is a directory $(id -un) can't read or enter; the docker build would fail on it." >&2
			echo "   install.sh doesn't delete directories. Fix its permissions (chmod u+rx) or remove it." >&2
			rc=1; continue
		fi
		[ -r "$f" ] && continue
		case "$f" in
			*.bun-build)
				if rm -f "$f" 2>/dev/null && [ ! -e "$f" ]; then
					echo "🧹 removed an unreadable bun build temp file (it would fail the docker build): $f" >&2
				else
					echo "❌ $f is unreadable and couldn't be removed; the docker build would fail on it." >&2
					echo "   Remove it yourself: rm -f '$f'" >&2
					rc=1
				fi ;;
			*)
				echo "❌ $f is unreadable by $(id -un); the docker build would fail on it." >&2
				echo "   install.sh doesn't delete files it doesn't recognise. Make it readable (chmod u+r) or remove it." >&2
				rc=1 ;;
		esac
	done < <(find "$dir" -path "$dir/.git" -prune -o \( -type f -o -type d \) -print 2>"$err")
	if [ -s "$err" ]; then
		echo "❌ couldn't check everything in $dir; find reported:" >&2
		sed 's/^/   /' "$err" >&2
		rc=1
	fi
	rm -f "$err"
	return "$rc"
}
# <<< install_clear_unreadable

if ! install_clear_unreadable "$SCRIPT_DIR"; then
	echo "❌ Unreadable files in the checkout (listed above); not starting the image build." >&2
	exit 1
fi

# Build into a dedicated cb-infra colima profile (never the human's default VM).
# Project VMs are seeded from it via save|load at run time. See
# docs/design/per-project-vm.md.
CB_INFRA_PROFILE="${DRIDOCK_INFRA_PROFILE:-cb-infra}"
CB_INFRA_CTX="colima-$CB_INFRA_PROFILE"
if ! colima status -p "$CB_INFRA_PROFILE" >/dev/null 2>&1; then
	echo "🟢 Starting '$CB_INFRA_PROFILE' colima VM (image store, one-time)..."
	# cb-infra only builds + serves the image (via save|load); it runs no workloads,
	# so it stays light. Idle use is ~430MB. Bump DRIDOCK_INFRA_MEMORY (e.g. 6) if
	# building the heavier `full` image ever runs short on memory. Legacy
	if ! colima start -p "$CB_INFRA_PROFILE" \
		--cpu "${DRIDOCK_INFRA_CPU:-2}" --memory "${DRIDOCK_INFRA_MEMORY:-4}" --disk "${DRIDOCK_INFRA_DISK:-40}"; then
		echo "❌ Failed to start the $CB_INFRA_PROFILE colima VM."
		exit 1
	fi
fi

# stamp the fork semver into the image (LABEL + ENV); `dridock checkversion` reads it
DRIDOCK_VERSION="$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || echo 0.0.0)"
# Only pass --build-arg CLAUDE_VERSION when explicitly overridden, so the
# Dockerfile's ARG default stays the single source of truth otherwise (#73).
_build_args=(--build-arg "DRIDOCK_VERSION=$DRIDOCK_VERSION")
if [ -n "$CLAUDE_VERSION_OVERRIDE" ]; then
	_build_args+=(--build-arg "CLAUDE_VERSION=$CLAUDE_VERSION_OVERRIDE")
	echo "   claude CLI pinned to $CLAUDE_VERSION_OVERRIDE for this build (overriding the Dockerfile ARG)."
	echo "   ⚠️  re-check the entrypoint's --remote-control capability probe — a too-old CLI"
	echo "      silently ignores unknown flags (#17)."
fi

# >>> install_report_other_variant (#109) -- tests/test_install_variant_check.sh runs this block
# Since #111 this script builds BOTH variants, so this runs only when
# DRIDOCK_SKIP_MINIMAL=1 left latest-minimal unbuilt: a tag from an earlier
# run may still be there and stale, and nothing else would say so (#109: a
# host had dridock:latest-minimal ten releases behind a fresh full image).
# Silent when the other tag is absent or current. Never fails the install.
#   install_report_other_variant <ctx> <built-tag> <other-tag> <want-version> <want-claude>
install_report_other_variant() {
	local ctx="$1" built="$2" other="$3" want_v="$4" want_c="$5" labels v c why="" runs fix
	labels="$(docker --context "$ctx" image inspect "$other" \
		--format '{{ index .Config.Labels "org.dridock.version" }}|{{ index .Config.Labels "org.dridock.claude-version" }}' 2>/dev/null)" || return 0
	v="${labels%%|*}"; c="${labels#*|}"
	[ "$v" = "<no value>" ] && v=""
	[ "$c" = "<no value>" ] && c=""
	[ "$v" != "$want_v" ] && why="harness ${v:-unstamped}, not $want_v"
	if [ -z "$c" ]; then
		why="${why:+$why; }no claude-version label (built before #78)"
	elif [ -n "$want_c" ] && [ "$c" != "$want_c" ]; then
		why="${why:+$why; }claude $c, not $want_c"
	fi
	[ -z "$why" ] && return 0
	case "$other" in
		*:latest-minimal) runs="dridock runs it when DRIDOCK_MINIMAL is set"; fix="make build-minimal (or re-run ./install.sh without DRIDOCK_SKIP_MINIMAL)" ;;
		*)                runs="dridock runs it when DRIDOCK_MINIMAL is unset"; fix="make build" ;;
	esac
	echo "⚠️  Built $built. $other in the same store is stale: $why." >&2
	echo "    $runs. Rebuild it with: $fix" >&2
}
# <<< install_report_other_variant

# >>> install_build_variants (#111) -- tests/test_install_build_variants.sh runs this block
# install.sh builds BOTH image variants (#111). Through 5.14.0 it built one,
# chosen by DRIDOCK_MINIMAL, and the other rotted: minimal sat ten releases
# behind (#109). DRIDOCK_MINIMAL now only says which image dridock RUNS, and
# that one is built first, as the primary. DRIDOCK_SKIP_MINIMAL=1 opts out of
# the minimal build.
#
# Both targets are `FROM base`, and nothing is pruned between the two builds
# (one prune runs after both, as in `make build-all`), so the second build
# reuses the base stage and costs only its own layers.
#
# A failed primary build fails the install. A failed secondary build doesn't
# stop the binary install, because the image dridock runs is fine, but it is
# reported now and again at the end, and the install exits non-zero.

# install_variant_plan <DRIDOCK_MINIMAL> <DRIDOCK_SKIP_MINIMAL>
#   Sets INSTALL_PRIMARY / INSTALL_SECONDARY to "target:tag-suffix"
#   (INSTALL_SECONDARY empty when skipped). rc 1 on a contradiction.
install_variant_plan() {
	local minimal="$1" skip_raw="$2" skip=""
	case "$(printf '%s' "$skip_raw" | tr '[:upper:]' '[:lower:]')" in
		1|true|yes|on) skip=1 ;;
		""|0|false|no|off) ;;
		*) echo "⚠️  DRIDOCK_SKIP_MINIMAL=\"$skip_raw\" isn't a recognised value (1/true/yes/on to skip): building the minimal image anyway." >&2 ;;
	esac
	# Same rule as dridock's ImageRef: any non-empty value selects minimal.
	if [ -n "$minimal" ]; then
		if [ -n "$skip" ]; then
			echo "❌ DRIDOCK_SKIP_MINIMAL is set, but DRIDOCK_MINIMAL=\"$minimal\" says dridock runs the minimal image." >&2
			echo "   Unset one of them: skipping the image dridock runs would leave nothing to run." >&2
			return 1
		fi
		INSTALL_PRIMARY="minimal:latest-minimal"; INSTALL_SECONDARY="full:latest"
	else
		INSTALL_PRIMARY="full:latest"
		if [ -n "$skip" ]; then INSTALL_SECONDARY=""; else INSTALL_SECONDARY="minimal:latest-minimal"; fi
	fi
	return 0
}

# install_build_variants <ctx> <image-name> <context-dir> [build args...]
#   Builds the plan from install_variant_plan. rc 1 when the primary build
#   fails. Sets INSTALL_SECONDARY_FAILED to the tag that didn't build, or "".
install_build_variants() {
	local ctx="$1" name="$2" dir="$3"; shift 3
	local target tag spec rc
	INSTALL_SECONDARY_FAILED=""
	for spec in "$INSTALL_PRIMARY" "$INSTALL_SECONDARY"; do
		[ -z "$spec" ] && continue
		target="${spec%%:*}"; tag="$name:${spec#*:}"
		echo "🔨 Building $tag (target: $target) into ${ctx#colima-}..."
		rc=0
		docker --context "$ctx" build "$@" --target "$target" -t "$tag" "$dir" || rc=$?
		[ "$rc" -eq 0 ] && continue
		if [ "$spec" = "$INSTALL_PRIMARY" ]; then
			echo "❌ Image build failed for $tag (rc=$rc). It's the image dridock runs, so the install stops here." >&2
			return 1
		fi
		INSTALL_SECONDARY_FAILED="$tag"
		echo "❌ The second image, $tag, failed to build (rc=$rc; the build output above has the error)." >&2
		echo "   Continuing: $name:${INSTALL_PRIMARY#*:}, the image dridock runs, built fine. Retry with: $(install_make_target "$tag")" >&2
	done
	return 0
}

install_make_target() {
	case "$1" in *:latest-minimal) echo "make build-minimal" ;; *) echo "make build" ;; esac
}

# install_prune <ctx> <profile>: once, after both builds. Each rebuild leaves
# the previous tag as a dangling image (8.5GB for full), and two builds per run
# fill cb-infra's 40GB disk twice as fast, so dangling images go. Build cache
# goes only once it's a week old. A plain `builder prune -f` (no -a) spares
# only cache an image still references, and the `image prune` before it has
# just orphaned the previous tag's base stage, so unfiltered the NEXT install
# would re-run that stage (Arfy measured it, #111 review). The age filter still
# bounds the accumulation that motivated the prune (2.20.1).
# Never fails the install.
INSTALL_CACHE_KEEP="168h"
install_prune() {
	local ctx="$1" profile="$2"
	echo "🧹 Pruning dangling images, and build cache older than $INSTALL_CACHE_KEEP, in $profile..."
	if ! { docker --context "$ctx" image prune -f >/dev/null \
		&& docker --context "$ctx" builder prune -f --filter "until=$INSTALL_CACHE_KEEP" >/dev/null; }; then
		echo "⚠️  prune in $profile failed (the images are built). Reclaim space later with: docker --context $ctx image prune -f" >&2
	fi
	return 0
}

# install_finish <secondary-failed-tag>: the end-of-install verdict. rc 1 if a
# build failed, so a scripted install can't mistake a partial one for done.
install_finish() {
	if [ -n "$1" ]; then
		echo "⚠️  dridock is installed, but $1 did not build, so this install is INCOMPLETE." >&2
		echo "   Retry it with: $(install_make_target "$1")" >&2
		return 1
	fi
	return 0
}
# <<< install_build_variants

install_variant_plan "${DRIDOCK_MINIMAL:-}" "${DRIDOCK_SKIP_MINIMAL:-}" || exit 1
echo "🔨 Building the local Claude Code images into $CB_INFRA_PROFILE (v$DRIDOCK_VERSION): $IMAGE_NAME:${INSTALL_PRIMARY#*:}${INSTALL_SECONDARY:+ and $IMAGE_NAME:${INSTALL_SECONDARY#*:}}"
install_build_variants "$CB_INFRA_CTX" "$IMAGE_NAME" "$SCRIPT_DIR" "${_build_args[@]}" || exit 1
install_prune "$CB_INFRA_CTX" "$CB_INFRA_PROFILE"
if [ -z "$INSTALL_SECONDARY" ]; then
	echo "   (DRIDOCK_SKIP_MINIMAL: not building $IMAGE_NAME:latest-minimal)"
	_want_claude="${CLAUDE_VERSION_OVERRIDE:-$(sed -n 's/^ARG CLAUDE_VERSION=\([^ ]*\).*/\1/p' "$SCRIPT_DIR/Dockerfile" 2>/dev/null | head -1)}"
	install_report_other_variant "$CB_INFRA_CTX" "$IMAGE_NAME:latest" "$IMAGE_NAME:latest-minimal" "$DRIDOCK_VERSION" "$_want_claude"
fi

# Compile the dridock TypeScript wrapper (a single ~95MB standalone binary via
# `bun build --compile`) and install it as `$BIN_NAME`. Since 4.0.0 this IS the
# dridock wrapper — the bash wrapper.sh has been removed (see #47 + CHANGELOG for
# rollback path via v3.4.1).
echo "🔨 Compiling dridock (TypeScript wrapper) → single binary..."
(cd "$SCRIPT_DIR/dridock-ts" && bun install --frozen-lockfile >/dev/null 2>&1 || true; bun run build) || {
	echo "❌ dridock TS build failed."
	exit 1
}
TS_BIN="$SCRIPT_DIR/dridock-ts/bin/dridock"
if [ ! -x "$TS_BIN" ]; then
	echo "❌ dridock binary not found at $TS_BIN after build."
	exit 1
fi

echo "📝 Installing $BIN_NAME to $BIN_PATH..."
mkdir -p "$INSTALL_DIR" 2>/dev/null
if [ -w "$INSTALL_DIR" ]; then
	install -m 755 "$TS_BIN" "$BIN_PATH"
elif command -v sudo >/dev/null 2>&1; then
	echo "⚠️  $INSTALL_DIR isn't writable; falling back to sudo."
	echo "    (set DRIDOCK_INSTALL_DIR to a user-writable dir like ~/.local/bin to avoid sudo)"
	sudo mkdir -p "$INSTALL_DIR" && sudo install -m 755 "$TS_BIN" "$BIN_PATH"
else
	echo "❌ $INSTALL_DIR isn't writable and sudo is unavailable."
	echo "   Set DRIDOCK_INSTALL_DIR to a writable directory and re-run."
	exit 1
fi

# #41 — on macOS, `bun build --compile` produces an adhoc linker-signed Mach-O.
# Overwriting the installed binary in place (upgrade path) invalidates the cached
# cdhash for that inode → AMFI SIGKILLs every subsequent invocation with rc 137
# ("Killed: 9"). First-install to a fresh path is fine; it's the SECOND install.sh
# run that breaks. Re-signing ad-hoc restores a valid signature. No cert, no sudo —
# same signature type bun emits.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
	# House rule (CLAUDE.md:105): a step that skips or fails silently must print a
	# stderr line the user will see AND surface a rc a caller can act on. Bare
	# `|| true` would swallow both; here we let codesign's own stderr through (so
	# the user sees "codesign: ...") and follow with a one-liner recovery hint.
	_cs_rc=0
	if [ -w "$BIN_PATH" ]; then
		codesign --force --sign - "$BIN_PATH" || _cs_rc=$?
	elif command -v sudo >/dev/null 2>&1; then
		sudo codesign --force --sign - "$BIN_PATH" || _cs_rc=$?
	fi
	if [ "$_cs_rc" -ne 0 ]; then
		echo "⚠️  codesign re-sign failed (rc=$_cs_rc). If $BIN_NAME now dies with 'Killed: 9', run:" >&2
		echo "    codesign --force --sign - $BIN_PATH" >&2
	fi
	unset _cs_rc
fi

# Clean up the pre-4.0.0 side-by-side `dridock-ts` binary if it exists at a
# different path than the new canonical `$BIN_PATH`. Pre-4.0.0 install.sh
# installed `dridock` (bash) + optionally `dridock-ts` (TS) side-by-side; 4.0.0
# collapses to just `$BIN_NAME` (TS binary, default `dridock`). Leaving the
# stale `dridock-ts` on PATH is the exact stale-binary footgun that bit Arfy
# on #40 — same binary name, different age, silent divergence. Removing it
# forces muscle memory (and any scripts) to update to the canonical name.
# Arfy called this out on #47 pre-build.
_STALE_TS="$INSTALL_DIR/dridock-ts"
if [ -e "$_STALE_TS" ] && [ "$_STALE_TS" != "$BIN_PATH" ]; then
	if [ -w "$_STALE_TS" ] || [ -w "$INSTALL_DIR" ]; then rm -f "$_STALE_TS"
	elif command -v sudo >/dev/null 2>&1; then sudo rm -f "$_STALE_TS"; fi
	if [ ! -e "$_STALE_TS" ]; then
		echo "🧹 Removed stale side-by-side $_STALE_TS (4.0.0 collapses to just '$BIN_NAME')."
	else
		echo "   ⚠ Could not remove stale $_STALE_TS — remove it manually so scripts don't run the old binary." >&2
	fi
fi
unset _STALE_TS

# Install host-agent.py next to the wrapper (`dridock host-agent` resolves it there via
# process.execPath — see #44). The opt-in Mac agent for `dridock host-agent up`
# (Approach 2). Best-effort; skip if absent.
if [ -f "$SCRIPT_DIR/host-agent.py" ]; then
	if [ -w "$INSTALL_DIR" ]; then install -m 755 "$SCRIPT_DIR/host-agent.py" "$INSTALL_DIR/host-agent.py"
	elif command -v sudo >/dev/null 2>&1; then sudo install -m 755 "$SCRIPT_DIR/host-agent.py" "$INSTALL_DIR/host-agent.py"; fi
	echo "📝 Installed host-agent.py to $INSTALL_DIR (for '$BIN_NAME host-agent')"
fi


# Install the /dridock Claude Code skill (human status glance) into the user's global
# skills dir, so /dridock works in any project. Skip with DRIDOCK_SKIP_SKILL=1
#
if [ -z "${DRIDOCK_SKIP_SKILL:-}" ] && [ -d "$SCRIPT_DIR/skills" ]; then
	SKILLS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
	if mkdir -p "$SKILLS_DIR" 2>/dev/null && cp -R "$SCRIPT_DIR/skills/." "$SKILLS_DIR/" 2>/dev/null; then
		echo "📝 Installed Claude Code skill(s) to $SKILLS_DIR (use /dridock in a project)"
	fi
fi

# Install the shell helpers (cbx-ps / cbx-sh / cbx-vm / cbx-claude + tab-completion)
# and source them from your rc. Skip with DRIDOCK_SKIP_SHELL_HELPERS=1 (legacy
#
if [ -z "${DRIDOCK_SKIP_SHELL_HELPERS:-}" ] && [ -f "$SCRIPT_DIR/claudebox-shell.sh" ]; then
	# Prefer the DRIDOCK_ override, else the default
	# ~/.local/share/dridock/. Legacy ~/.local/share/claudebox/ is NEVER
	# auto-migrated. If both dirs co-exist post-upgrade, we install to dridock/
	# and print a one-liner recommending cleanup.
	_LEGACY_SHARE="$HOME/.local/share/claudebox"
	SHARE_DIR="${DRIDOCK_SHARE_DIR:-$HOME/.local/share/dridock}"
	mkdir -p "$SHARE_DIR"
	install -m 644 "$SCRIPT_DIR/claudebox-shell.sh" "$SHARE_DIR/claudebox-shell.sh"
	if [ "$SHARE_DIR" != "$_LEGACY_SHARE" ] && [ -e "$_LEGACY_SHARE/claudebox-shell.sh" ]; then
		echo "🧹 note: legacy $_LEGACY_SHARE/claudebox-shell.sh still present. Safe to remove"
		echo "   after confirming your ~/.zshrc / ~/.bashrc \`source\` line points at $SHARE_DIR."
	fi
	MARKER="# claudebox-shell helpers"
	case "${SHELL##*/}" in
		zsh) RC="$HOME/.zshrc" ;;
		*)   RC="$HOME/.bashrc" ;;
	esac
	if [ -f "$RC" ] && grep -qF "$MARKER" "$RC"; then
		echo "🐚 Shell helpers already sourced from $RC (updated $SHARE_DIR/claudebox-shell.sh)"
	else
		{ echo ""; echo "$MARKER"; echo "source \"$SHARE_DIR/claudebox-shell.sh\""; } >> "$RC"
		echo "🐚 Installed shell helpers -> $SHARE_DIR/claudebox-shell.sh (sourced from $RC)"
		echo "   new commands: cbx-ps, cbx-sh, cbx-logs, cbx-vm, cbx-claude"
		echo "   run 'source $RC' or open a new shell to use them."
	fi
fi

# Bash completion (#13, 2.24.0). Drop the completion script into the XDG-standard
# path where bash-completion picks it up automatically. Non-fatal.
COMPLETION_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
if mkdir -p "$COMPLETION_DIR" 2>/dev/null; then
	if "$BIN_PATH" completion bash > "$COMPLETION_DIR/$BIN_NAME" 2>/dev/null; then
		echo "🐚 Installed bash completion -> $COMPLETION_DIR/$BIN_NAME"
		if [ -z "${BASH_COMPLETION_VERSINFO:-}" ] && ! [ -r /usr/local/etc/profile.d/bash_completion.sh ] && ! [ -r /opt/homebrew/etc/profile.d/bash_completion.sh ] && ! [ -r /opt/local/etc/bash_completion ]; then
			echo "   ℹ️  bash-completion not detected — install it (e.g. 'brew install bash-completion') for auto-loading,"
			echo "      or source the file yourself:  source $COMPLETION_DIR/$BIN_NAME"
		fi
	else
		echo "   ⚠ '$BIN_NAME completion bash' failed; skipping shell completion."
	fi
fi

install_finish "$INSTALL_SECONDARY_FAILED" || exit 1
echo "✅ dridock (Claude Code) setup complete! You can now use '$BIN_NAME' command from any directory."

# Nudge if the install dir isn't on PATH (common for ~/.local/bin on macOS)
case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*)
		echo ""
		echo "ℹ️  $INSTALL_DIR is not on your PATH. Add it, e.g.:"
		echo "     echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && exec \$SHELL"
		;;
esac

echo ""
echo "🔑 SSH key for git auth INSIDE the container is at:"
echo "   $HOME/.ssh/claudebox/id_ed25519.pub"
echo "   Add it to EACH git host you push/pull from inside claudebot (GitHub, GitLab,"
echo "   Bitbucket, Gitea, self-hosted — one key covers them all). This is the harness's"
echo "   provider-agnostic path for git ops (see docs/design/git-and-api-auth.md)."
echo ""
echo "   Per-provider API tokens (for gh/glab/… inside the container, NOT for git):"
echo "     $BIN_NAME bootstrap --seed-secret GH_TOKEN='gh auth token'      # GitHub"
echo "     $BIN_NAME bootstrap --seed-secret GITLAB_TOKEN='glab auth token'  # GitLab"
echo "   secrets.env stores them per-project (gitignored, chmod 600)."

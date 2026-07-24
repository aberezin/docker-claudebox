#!/usr/bin/env bash

BIN_NAME="${1:-${DRIDOCK_BIN_NAME:-${CLAUDEBOX_BIN_NAME:-${CLAUDE_BIN_NAME:-dridock}}}}"
# Default to a user-writable dir so install needs no sudo (this fork avoids macOS
# sudo). Override with DRIDOCK_INSTALL_DIR (legacy CLAUDEBOX_INSTALL_DIR / CLAUDE_INSTALL_DIR
# still accepted for one deprecation cycle).
INSTALL_DIR="${DRIDOCK_INSTALL_DIR:-${CLAUDEBOX_INSTALL_DIR:-${CLAUDE_INSTALL_DIR:-$HOME/.local/bin}}}"
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

IMAGE_NAME="${DRIDOCK_IMAGE_NAME:-${CLAUDEBOX_IMAGE_NAME:-dridock}}"
CLAUDE_TAG="latest"
BUILD_TARGET="full"
_minimal="${DRIDOCK_MINIMAL:-${CLAUDEBOX_MINIMAL:-${CLAUDE_MINIMAL:-}}}"
if [ -n "$_minimal" ]; then
	CLAUDE_TAG="latest-minimal"
	BUILD_TARGET="minimal"
fi

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

# Build into a dedicated cb-infra colima profile (never the human's default VM).
# Project VMs are seeded from it via save|load at run time. See
# docs/design/per-project-vm.md.
CB_INFRA_PROFILE="${DRIDOCK_INFRA_PROFILE:-${CLAUDEBOX_INFRA_PROFILE:-cb-infra}}"
CB_INFRA_CTX="colima-$CB_INFRA_PROFILE"
if ! colima status -p "$CB_INFRA_PROFILE" >/dev/null 2>&1; then
	echo "🟢 Starting '$CB_INFRA_PROFILE' colima VM (image store, one-time)..."
	# cb-infra only builds + serves the image (via save|load); it runs no workloads,
	# so it stays light. Idle use is ~430MB. Bump DRIDOCK_INFRA_MEMORY (e.g. 6) if
	# building the heavier `full` image ever runs short on memory. Legacy
	# CLAUDEBOX_INFRA_* names accepted for one deprecation cycle.
	if ! colima start -p "$CB_INFRA_PROFILE" \
		--cpu "${DRIDOCK_INFRA_CPU:-${CLAUDEBOX_INFRA_CPU:-2}}" --memory "${DRIDOCK_INFRA_MEMORY:-${CLAUDEBOX_INFRA_MEMORY:-4}}" --disk "${DRIDOCK_INFRA_DISK:-${CLAUDEBOX_INFRA_DISK:-40}}"; then
		echo "❌ Failed to start the $CB_INFRA_PROFILE colima VM."
		exit 1
	fi
fi

# stamp the fork semver into the image (LABEL + ENV); `dridock checkversion` reads it
DRIDOCK_VERSION="$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || echo 0.0.0)"
echo "🔨 Building local Claude Code image into $CB_INFRA_PROFILE ($IMAGE_NAME:$CLAUDE_TAG v$DRIDOCK_VERSION, target: $BUILD_TARGET)..."
if ! docker --context "$CB_INFRA_CTX" build --build-arg DRIDOCK_VERSION="$DRIDOCK_VERSION" --target "$BUILD_TARGET" -t "$IMAGE_NAME:$CLAUDE_TAG" "$SCRIPT_DIR"; then
	echo "❌ Image build failed."
	exit 1
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

# Install the shared env-rename map (#16, 3.2.1) into the XDG data dir. Same file
# is baked into the container image at /usr/local/lib/dridock/env-rename.map for
# the entrypoint's symmetric aliaser (CLAUDEBOX_* ↔ DRIDOCK_* legacy compat).
# Best-effort. See docs/design/env-var-rename.md.
if [ -f "$SCRIPT_DIR/env-rename.map" ]; then
	DRIDOCK_SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dridock"
	if mkdir -p "$DRIDOCK_SHARE_DIR" 2>/dev/null && install -m 644 "$SCRIPT_DIR/env-rename.map" "$DRIDOCK_SHARE_DIR/env-rename.map" 2>/dev/null; then
		echo "📝 Installed env-rename.map to $DRIDOCK_SHARE_DIR (CLAUDEBOX_* ↔ DRIDOCK_* compat)"
	fi
fi

# Install the /dridock Claude Code skill (human status glance) into the user's global
# skills dir, so /dridock works in any project. Skip with DRIDOCK_SKIP_SKILL=1
# (CLAUDEBOX_SKIP_SKILL still accepted for one deprecation cycle).
if [ -z "${DRIDOCK_SKIP_SKILL:-${CLAUDEBOX_SKIP_SKILL:-}}" ] && [ -d "$SCRIPT_DIR/skills" ]; then
	SKILLS_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
	if mkdir -p "$SKILLS_DIR" 2>/dev/null && cp -R "$SCRIPT_DIR/skills/." "$SKILLS_DIR/" 2>/dev/null; then
		echo "📝 Installed Claude Code skill(s) to $SKILLS_DIR (use /dridock in a project)"
	fi
fi

# Install the shell helpers (cbx-ps / cbx-sh / cbx-vm / cbx-claude + tab-completion)
# and source them from your rc. Skip with DRIDOCK_SKIP_SHELL_HELPERS=1 (legacy
# CLAUDEBOX_SKIP_SHELL_HELPERS accepted for one deprecation cycle).
if [ -z "${DRIDOCK_SKIP_SHELL_HELPERS:-${CLAUDEBOX_SKIP_SHELL_HELPERS:-}}" ] && [ -f "$SCRIPT_DIR/claudebox-shell.sh" ]; then
	# Prefer DRIDOCK_ override, then legacy CLAUDEBOX_ override, then default
	# ~/.local/share/dridock/. Legacy ~/.local/share/claudebox/ is NEVER
	# auto-migrated. If both dirs co-exist post-upgrade, we install to dridock/
	# and print a one-liner recommending cleanup.
	_LEGACY_SHARE="$HOME/.local/share/claudebox"
	SHARE_DIR="${DRIDOCK_SHARE_DIR:-${CLAUDEBOX_SHARE_DIR:-$HOME/.local/share/dridock}}"
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

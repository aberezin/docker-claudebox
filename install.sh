#!/usr/bin/env bash

BIN_NAME="${1:-${CLAUDEBOX_BIN_NAME:-${CLAUDE_BIN_NAME:-claudebox}}}"
# Default to a user-writable dir so install needs no sudo (this fork avoids macOS
# sudo). Override with CLAUDEBOX_INSTALL_DIR (e.g. /usr/local/bin) if you prefer.
INSTALL_DIR="${CLAUDEBOX_INSTALL_DIR:-${CLAUDE_INSTALL_DIR:-$HOME/.local/bin}}"
BIN_PATH="$INSTALL_DIR/$BIN_NAME"

echo "🚀 Starting Claude Code setup (binary: $BIN_NAME)..."

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
# run from a checkout of the repo (the Dockerfile and wrapper.sh live next to it).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd)"

IMAGE_NAME="${CLAUDEBOX_IMAGE_NAME:-claudebox}"
CLAUDE_TAG="latest"
BUILD_TARGET="full"
_minimal="${CLAUDEBOX_MINIMAL:-${CLAUDE_MINIMAL:-}}"
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

# Build into a dedicated cb-infra colima profile (never the human's default VM).
# Project VMs are seeded from it via save|load at run time. See
# docs/design/per-project-vm.md.
CB_INFRA_PROFILE="${CLAUDEBOX_INFRA_PROFILE:-cb-infra}"
CB_INFRA_CTX="colima-$CB_INFRA_PROFILE"
if ! colima status -p "$CB_INFRA_PROFILE" >/dev/null 2>&1; then
	echo "🟢 Starting '$CB_INFRA_PROFILE' colima VM (image store, one-time)..."
	# cb-infra only builds + serves the image (via save|load); it runs no workloads,
	# so it stays light. Idle use is ~430MB. Bump CLAUDEBOX_INFRA_MEMORY (e.g. 6) if
	# building the heavier `full` image ever runs short on memory.
	if ! colima start -p "$CB_INFRA_PROFILE" \
		--cpu "${CLAUDEBOX_INFRA_CPU:-2}" --memory "${CLAUDEBOX_INFRA_MEMORY:-4}" --disk "${CLAUDEBOX_INFRA_DISK:-40}"; then
		echo "❌ Failed to start the $CB_INFRA_PROFILE colima VM."
		exit 1
	fi
fi

# stamp the fork semver into the image (LABEL + ENV); `claudebox checkversion` reads it
CLAUDEBOX_VERSION="$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || echo 0.0.0)"
echo "🔨 Building local Claude Code image into $CB_INFRA_PROFILE ($IMAGE_NAME:$CLAUDE_TAG v$CLAUDEBOX_VERSION, target: $BUILD_TARGET)..."
if ! docker --context "$CB_INFRA_CTX" build --build-arg CLAUDEBOX_VERSION="$CLAUDEBOX_VERSION" --target "$BUILD_TARGET" -t "$IMAGE_NAME:$CLAUDE_TAG" "$SCRIPT_DIR"; then
	echo "❌ Image build failed."
	exit 1
fi

# install wrapper.sh from this checkout
WRAPPER_TMP="$(mktemp /tmp/claude-wrapper-XXXXXX.sh)"
if [ -f "$SCRIPT_DIR/wrapper.sh" ]; then
	echo "📝 Using local wrapper.sh..."
	cp "$SCRIPT_DIR/wrapper.sh" "$WRAPPER_TMP"
else
	echo "❌ wrapper.sh not found in $SCRIPT_DIR"
	rm -f "$WRAPPER_TMP"
	exit 1
fi

if [ ! -s "$WRAPPER_TMP" ]; then
	echo "❌ wrapper.sh is empty — download failed"
	rm -f "$WRAPPER_TMP"
	exit 1
fi

echo "📝 Installing $BIN_NAME to $BIN_PATH..."
mkdir -p "$INSTALL_DIR" 2>/dev/null
if [ -w "$INSTALL_DIR" ]; then
	install -m 755 "$WRAPPER_TMP" "$BIN_PATH"
elif command -v sudo >/dev/null 2>&1; then
	echo "⚠️  $INSTALL_DIR isn't writable; falling back to sudo."
	echo "    (set CLAUDEBOX_INSTALL_DIR to a user-writable dir like ~/.local/bin to avoid sudo)"
	sudo mkdir -p "$INSTALL_DIR" && sudo install -m 755 "$WRAPPER_TMP" "$BIN_PATH"
else
	echo "❌ $INSTALL_DIR isn't writable and sudo is unavailable."
	echo "   Set CLAUDEBOX_INSTALL_DIR to a writable directory and re-run."
	rm -f "$WRAPPER_TMP"
	exit 1
fi
rm -f "$WRAPPER_TMP"

# Install the shell helpers (cbx-ps / cbx-sh / cbx-vm / cbx-claude + tab-completion)
# and source them from your rc. Skip with CLAUDEBOX_SKIP_SHELL_HELPERS=1.
if [ -z "${CLAUDEBOX_SKIP_SHELL_HELPERS:-}" ] && [ -f "$SCRIPT_DIR/claudebox-shell.sh" ]; then
	SHARE_DIR="${CLAUDEBOX_SHARE_DIR:-$HOME/.local/share/claudebox}"
	mkdir -p "$SHARE_DIR"
	install -m 644 "$SCRIPT_DIR/claudebox-shell.sh" "$SHARE_DIR/claudebox-shell.sh"
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

echo "✅ Claude Code setup complete! You can now use '$BIN_NAME' command from any directory."

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
echo "🔑 Don't forget to add your public key to GitHub:"
echo "   $HOME/.ssh/claudebox/id_ed25519.pub"

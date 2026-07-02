#!/usr/bin/env bash

BIN_NAME="${1:-${CLAUDEBOX_BIN_NAME:-${CLAUDE_BIN_NAME:-claudebox}}}"
INSTALL_DIR="${CLAUDEBOX_INSTALL_DIR:-${CLAUDE_INSTALL_DIR:-/usr/local/bin}}"
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
	if ! colima start -p "$CB_INFRA_PROFILE" \
		--cpu "${CLAUDEBOX_INFRA_CPU:-4}" --memory "${CLAUDEBOX_INFRA_MEMORY:-8}" --disk "${CLAUDEBOX_INFRA_DISK:-80}"; then
		echo "❌ Failed to start the $CB_INFRA_PROFILE colima VM."
		exit 1
	fi
fi

echo "🔨 Building local Claude Code image into $CB_INFRA_PROFILE ($IMAGE_NAME:$CLAUDE_TAG, target: $BUILD_TARGET)..."
if ! docker --context "$CB_INFRA_CTX" build --target "$BUILD_TARGET" -t "$IMAGE_NAME:$CLAUDE_TAG" "$SCRIPT_DIR"; then
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
sudo install -m 755 "$WRAPPER_TMP" "$BIN_PATH"
rm -f "$WRAPPER_TMP"

echo "✅ Claude Code setup complete! You can now use '$BIN_NAME' command from any directory."
echo ""
echo "🔑 Don't forget to add your public key to GitHub:"
echo "   $HOME/.ssh/claudebox/id_ed25519.pub"

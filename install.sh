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

# Install host-agent.py next to the wrapper (the wrapper resolves it there) — the opt-in
# Mac agent for `dridock host-agent up` (Approach 2). Best-effort; skip if absent.
if [ -f "$SCRIPT_DIR/host-agent.py" ]; then
	if [ -w "$INSTALL_DIR" ]; then install -m 755 "$SCRIPT_DIR/host-agent.py" "$INSTALL_DIR/host-agent.py"
	elif command -v sudo >/dev/null 2>&1; then sudo install -m 755 "$SCRIPT_DIR/host-agent.py" "$INSTALL_DIR/host-agent.py"; fi
	echo "📝 Installed host-agent.py to $INSTALL_DIR (for 'dridock host-agent')"
fi

# Install the shared env-rename map (#16, 3.2.1) into the XDG data dir. The wrapper
# reads it at source-time to alias renamed CLAUDEBOX_* env vars to their DRIDOCK_*
# canonical names. Same file is baked into the container image at
# /usr/local/lib/dridock/env-rename.map for the entrypoint's own symmetric aliaser.
# Best-effort; skipping only breaks legacy-name compat (all in-file reads use the
# canonical names). See docs/design/env-var-rename.md.
if [ -f "$SCRIPT_DIR/env-rename.map" ]; then
	DRIDOCK_SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dridock"
	if mkdir -p "$DRIDOCK_SHARE_DIR" 2>/dev/null && install -m 644 "$SCRIPT_DIR/env-rename.map" "$DRIDOCK_SHARE_DIR/env-rename.map" 2>/dev/null; then
		echo "📝 Installed env-rename.map to $DRIDOCK_SHARE_DIR (CLAUDEBOX_* ↔ DRIDOCK_* compat)"
	fi
fi

# Install the /dridock Claude Code skill (human status glance) into the user's global
# skills dir, so /dridock works in any project. Skip with CLAUDEBOX_SKIP_SKILL=1
# (kept as the alias name for one deprecation cycle).
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
	# SHARE_DIR resolution mirrors wrapper.sh's cb_xdg_dir pattern for the .config/
	# sibling: prefer the DRIDOCK_ override, then the legacy CLAUDEBOX_ override, then
	# the ~/.local/share/dridock/ default (3.0+). Legacy ~/.local/share/claudebox/ is
	# NEVER auto-migrated — user might have their own files there. If both dirs
	# co-exist post-upgrade, we install to dridock/ and print a one-liner recommending
	# cleanup.
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
# path where bash-completion picks it up automatically. Non-fatal: if the wrapper
# doesn't ship `completion bash` yet (rare fresh-clone case), or the dir isn't
# writable, we skip with a note. zsh users with `bashcompinit` loaded pick this up too.
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

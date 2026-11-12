# Docker image configuration
# This fork builds a LOCAL image (bare repo name, no registry prefix) so Docker
# never pulls from Docker Hub. Override with `make IMAGE_NAME=... build`.
IMAGE_NAME ?= dridock
TAG ?= latest

# Fork semver stamped into the image (LABEL + ENV); read by `claudebox checkversion`.
DRIDOCK_VERSION := $(shell cat VERSION 2>/dev/null || echo 0.0.0)

# The image is built into a dedicated colima profile (cb-infra), never the
# human's `default` VM. Project VMs are seeded from cb-infra via save|load at
# run time (see docs/design/per-project-vm.md). cb-infra only builds + serves the
# image (no workloads), so it's kept light — bump CB_INFRA_MEMORY if a `full` build
# ever runs short.
CB_INFRA_PROFILE ?= cb-infra
CB_INFRA_CTX      := colima-$(CB_INFRA_PROFILE)
CB_INFRA_CPU      ?= 2
CB_INFRA_MEMORY   ?= 4
CB_INFRA_DISK     ?= 40
# Backend: colima (macOS/prod — build into cb-infra) or docker (CI / in-container harness dev —
# build on the AMBIENT daemon, no colima). Auto-selects `docker` inside a container. This does NOT
# proxy docker to the Mac; it uses the local VM's daemon. The opt-in `claudebox host-agent` proxies
# colima only where real VMs are genuinely needed. See docs/design/backends.md (task #15).
DRIDOCK_BACKEND ?= $(shell [ -f /.dockerenv ] && echo docker || echo colima)
ifeq ($(DRIDOCK_BACKEND),docker)
  DOCKER_INFRA := docker
  INFRA_DEP    :=
else
  DOCKER_INFRA := docker --context $(CB_INFRA_CTX)
  INFRA_DEP    := infra-up
endif

.PHONY: build build-minimal build-all infra-up test clean help

# Default target
all: build

# Ensure the cb-infra colima VM exists and is running (image store + build host)
infra-up:
	@colima status -p $(CB_INFRA_PROFILE) >/dev/null 2>&1 || \
		colima start -p $(CB_INFRA_PROFILE) --cpu $(CB_INFRA_CPU) --memory $(CB_INFRA_MEMORY) --disk $(CB_INFRA_DISK)

# The build and prune steps, as recipes so build-all can run both builds
# before a single prune (#111).
define BUILD_FULL
	$(DOCKER_INFRA) build --build-arg DRIDOCK_VERSION=$(DRIDOCK_VERSION) --target full -t $(IMAGE_NAME):$(TAG) .
endef
define BUILD_MINIMAL
	$(DOCKER_INFRA) build --build-arg DRIDOCK_VERSION=$(DRIDOCK_VERSION) --target minimal -t $(IMAGE_NAME):$(TAG)-minimal .
endef
define PRUNE
	@# the previous tag is now a dangling <none> image — reclaim it
	$(DOCKER_INFRA) image prune -f
	@# also prune UNREFERENCED BuildKit cache (non-`-a`, so recently-used layers survive).
	@# Without this, cb-infra's BuildKit cache grows unbounded over many rebuilds — Alan
	@# hit a 41 GB accumulation over four days of iteration before a nuclear prune.
	$(DOCKER_INFRA) builder prune -f
endef

# Build the full image into cb-infra
build: $(INFRA_DEP)
	$(BUILD_FULL)
	$(PRUNE)

# Build the minimal image into cb-infra
build-minimal: $(INFRA_DEP)
	$(BUILD_MINIMAL)
	$(PRUNE)

# Build both, pruning once at the end. Through 5.14.0 this was
# `build-all: build build-minimal`, so build's prune ran between the two and
# the minimal build re-ran the shared base stage instead of reusing it (#111).
build-all: $(INFRA_DEP)
	$(BUILD_FULL)
	$(BUILD_MINIMAL)
	$(PRUNE)

# Run all tests
test:
	bash test.sh

# Clean up images (in cb-infra)
clean:
	$(DOCKER_INFRA) rmi $(IMAGE_NAME):$(TAG) || true
	$(DOCKER_INFRA) rmi $(IMAGE_NAME):$(TAG)-minimal || true

# Show available targets
help:
	@echo "Available targets:"
	@echo "  build          - Build the full image into the cb-infra colima VM"
	@echo "  build-minimal  - Build the minimal image into the cb-infra colima VM"
	@echo "  build-all      - Build both images"
	@echo "  infra-up       - Ensure the cb-infra colima VM is running"
	@echo "  test           - Run all tests"
	@echo "  clean          - Remove built images from cb-infra"
	@echo "  hooks          - Install this repo's git hooks into .git/hooks (once per clone)"
	@echo "  hooks-check    - Report missing/stale hooks without installing"
	@echo "  help           - Show this help message"

# Install the repo's git hooks into .git/hooks (#80-adjacent, 2026-09-01).
# Copied rather than symlinked via core.hooksPath: that setting is
# worktree-relative, so the hook disappears on any branch without the file —
# master included — and a guard that silently vanishes is worse than none.
#
# #104: the body used to name pre-commit here, so a second hook would have
# needed a second line nobody would remember to add. The installer walks
# .githooks/ instead, and `--check` is what the SessionStart hook calls to
# notice a clone where this was never run (or where the copy went stale).
.PHONY: hooks hooks-check
hooks:
	@bash .githooks/install.sh

hooks-check:
	@bash .githooks/install.sh --check || { echo "run \`make hooks\`"; exit 1; }

# Docker image configuration
# This fork builds a LOCAL image (bare repo name, no registry prefix) so Docker
# never pulls from Docker Hub. Override with `make IMAGE_NAME=... build`.
IMAGE_NAME ?= claudebox
TAG ?= latest

# Fork semver stamped into the image (LABEL + ENV); read by `claudebox checkversion`.
CLAUDEBOX_VERSION := $(shell cat VERSION 2>/dev/null || echo 0.0.0)

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
CLAUDEBOX_BACKEND ?= $(shell [ -f /.dockerenv ] && echo docker || echo colima)
ifeq ($(CLAUDEBOX_BACKEND),docker)
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

# Build the full image into cb-infra
build: $(INFRA_DEP)
	$(DOCKER_INFRA) build --build-arg CLAUDEBOX_VERSION=$(CLAUDEBOX_VERSION) --target full -t $(IMAGE_NAME):$(TAG) .
	@# the previous claudebox:latest is now a dangling <none> image — reclaim it
	$(DOCKER_INFRA) image prune -f
	@# also prune UNREFERENCED BuildKit cache (non-`-a`, so recently-used layers survive).
	@# Without this, cb-infra's BuildKit cache grows unbounded over many rebuilds — Alan
	@# hit a 41 GB accumulation over four days of iteration before a nuclear prune.
	$(DOCKER_INFRA) builder prune -f

# Build the minimal image into cb-infra
build-minimal: $(INFRA_DEP)
	$(DOCKER_INFRA) build --build-arg CLAUDEBOX_VERSION=$(CLAUDEBOX_VERSION) --target minimal -t $(IMAGE_NAME):$(TAG)-minimal .
	$(DOCKER_INFRA) image prune -f
	$(DOCKER_INFRA) builder prune -f

# Build both
build-all: build build-minimal

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
	@echo "  help           - Show this help message"

# Docker image configuration
# This fork builds a LOCAL image (bare repo name, no registry prefix) so Docker
# never pulls from Docker Hub. Override with `make IMAGE_NAME=... build`.
IMAGE_NAME ?= claudebox
TAG ?= latest

# The image is built into a dedicated colima profile (cb-infra), never the
# human's `default` VM. Project VMs are seeded from cb-infra via save|load at
# run time (see docs/design/per-project-vm.md). Sizing is generous enough to
# build the full image.
CB_INFRA_PROFILE ?= cb-infra
CB_INFRA_CTX      := colima-$(CB_INFRA_PROFILE)
CB_INFRA_CPU      ?= 4
CB_INFRA_MEMORY   ?= 8
CB_INFRA_DISK     ?= 80
DOCKER_INFRA      := docker --context $(CB_INFRA_CTX)

.PHONY: build build-minimal build-all infra-up test clean help

# Default target
all: build

# Ensure the cb-infra colima VM exists and is running (image store + build host)
infra-up:
	@colima status -p $(CB_INFRA_PROFILE) >/dev/null 2>&1 || \
		colima start -p $(CB_INFRA_PROFILE) --cpu $(CB_INFRA_CPU) --memory $(CB_INFRA_MEMORY) --disk $(CB_INFRA_DISK)

# Build the full image into cb-infra
build: infra-up
	$(DOCKER_INFRA) build --target full -t $(IMAGE_NAME):$(TAG) .

# Build the minimal image into cb-infra
build-minimal: infra-up
	$(DOCKER_INFRA) build --target minimal -t $(IMAGE_NAME):$(TAG)-minimal .

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

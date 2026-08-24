#!/usr/bin/env bash
# summary: verify the scaffolder CLIs are actually present (not just marked installed)
# Run by the entrypoint when the completion marker exists — a marker records that
# on.sh ran, not that its payload survived (#75). Exit 0 = present, non-zero =
# reinstall. Checks one representative binary rather than all five: they install
# and vanish together, and a cheap check runs on every container start.
set -uo pipefail
command -v create-vite >/dev/null 2>&1

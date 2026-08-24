#!/usr/bin/env bash
# summary: install framework-scaffolder CLIs (create-vite, create-next-app, @vue/cli, @angular/cli, express-generator)
# First-enable installer. Deliberately does NOT install `create-react-app` — React
# deprecated it in early 2023 in favor of Vite / Next.js, both included below.
# Marker-guarded by the entrypoint's _install_features (one-time per project).
#
# INSTALLS INTO ~/.claude, NOT the container (#75). The completion marker
# (~/.claude/.feature-web-scaffolders) lives on the bind mount and survives a
# container recreate. A plain `npm install -g` writes to the CONTAINER
# filesystem, which does not — so after any recreate the binaries were gone, the
# marker remained, the entrypoint skipped reinstalling, and the feature reported
# enabled with its tools missing. Silent success over discarded work.
#
# `--prefix /home/claude/.claude` puts binaries in ~/.claude/bin (already on PATH
# — entrypoint.sh:920, and the documented home for per-project commands) and
# modules under ~/.claude/lib/node_modules. Marker and payload now share one
# persistence domain, which is the rule this has to satisfy; see
# docs/design/features-system.md.
set -uo pipefail
npm install -g --prefix /home/claude/.claude \
    create-vite \
    create-next-app \
    @vue/cli \
    @angular/cli \
    express-generator

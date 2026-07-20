#!/usr/bin/env bash
# summary: install framework-scaffolder CLIs (create-vite, create-next-app, @vue/cli, @angular/cli, express-generator)
# First-enable installer. Deliberately does NOT install `create-react-app` — React
# deprecated it in early 2023 in favor of Vite / Next.js, both included below.
# Marker-guarded by the entrypoint's _install_features (one-time per project).
set -uo pipefail
npm install -g \
    create-vite \
    create-next-app \
    @vue/cli \
    @angular/cli \
    express-generator

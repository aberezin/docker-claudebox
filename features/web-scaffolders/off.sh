#!/usr/bin/env bash
# summary: uninstall the web-scaffolder CLIs (installed by on.sh)
# Called by `dridock features disable web-scaffolders`. Idempotent — npm silently
# succeeds on a missing package. We don't touch `create-react-app` since we never
# installed it (it's the deprecated tool this feature deliberately replaces).
set -uo pipefail
npm uninstall -g \
    create-vite \
    create-next-app \
    @vue/cli \
    @angular/cli \
    express-generator >/dev/null 2>&1 || true

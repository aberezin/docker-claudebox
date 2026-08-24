#!/usr/bin/env bash
# summary: remove the framework-scaffolder CLIs installed by on.sh
#
# MUST mirror on.sh's --prefix (#75). Without it npm uninstalls from the
# CONTAINER's global prefix while on.sh installed into ~/.claude — so disabling
# the feature would report success and leave every tool in place.
set -uo pipefail
npm uninstall -g --prefix /home/claude/.claude \
    create-vite \
    create-next-app \
    @vue/cli \
    @angular/cli \
    express-generator >/dev/null 2>&1 || true

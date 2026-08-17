#!/bin/bash
# SessionEnd hook: cleanly SIGTERM the background team-watch fetcher when
# a Claude session ends. GATED on `[ -f /.dockerenv ]` because this
# behavior is CONTAINER-ONLY — added for #70.
#
# On the container (Bear): the container's PID 1 is claude (via
# `exec setpriv ... bash -c '... exec claude ...'` at entrypoint tail).
# When claude exits, PID 1 exits, docker stops the container, SIGKILL
# cascades to the fetcher — before it can run its own SIGTERM handler
# (persist state, remove pidfile). Firing `dridock team fetcher stop`
# on SessionEnd lets the fetcher exit cleanly during Claude's own
# teardown window, ahead of docker's SIGKILL grace-period expiry.
#
# On the host (Arfy): the fetcher SHOULD outlive the session —
# detachment is what lets events accumulate while nothing is attached
# (#56). Killing it on SessionEnd would break that property and
# convert "collects continuously" into "collects only while attached",
# which is a worse bug than the one this hook fixes. Gate makes this
# hook a no-op there. See #70 and #71 for the inverse-lifecycle
# writeup.
#
# The fetcher-stop call is async by design: `dridock team fetcher stop`
# sends SIGTERM + returns; the fetcher's own handler runs during
# Claude's teardown. `&` and stderr swallow so this hook exits FAST
# regardless of the fetcher's teardown latency — Claude's SessionEnd
# hook timeout was historically 1.5s (see Claude Code changelog;
# CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS since a later release), and
# a hook that outlives the timeout gets killed anyway. Fire-and-forget
# is the shape that survives whatever timeout applies.

set -u

# Container-only: no-op on the host (see #70 rationale above).
if [ ! -f /.dockerenv ]; then
    exit 0
fi

# Fire and forget. The fetcher's own SIGTERM handler
# (TeamCommand.runWatch) does the state-persist + pidfile removal;
# this hook's job is only to send the signal.
dridock team fetcher stop >/dev/null 2>&1 &

exit 0

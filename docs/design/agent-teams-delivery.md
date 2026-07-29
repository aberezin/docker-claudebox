# Agent-teams delivery model

> Spec for how team-bus messages reach a Claude agent's session reliably.
> Companion of [`agent-teams.md`](agent-teams.md) — that doc covers named
> agents, roster, message header grammar, and the delivery predicate;
> this doc covers what happens between "a message is on GitHub" and "it
> lands in the agent's chat context".
>
> Motivating incident: [#56](https://github.com/aberezin/docker-claudebox/issues/56).
> The `dridock team watch` primitive was sound; getting its output into a
> Claude session was per-session ritual with silent failure modes.

## Motivation

The bug class this model exists to prevent: **delivery works by
remembering, and every way to forget is silent.** The four modes
observed in the wild:

1. Session opens with no live layer at all — the human forgot to arm.
2. A live watcher armed in a terminal dies the moment that terminal is
   used for anything else.
3. A terminal watcher consumes events using the shared cursor — the
   agent never sees them (starvation).
4. An armed session-scoped Monitor dies with the session — the next
   session starts undelivered.

None of these produce error signals. The redesign turns delivery into
a durable-by-default pipeline: **fetcher outlives sessions, inbox is
the spool, hook self-arms, Monitor tails the inbox.**

## Architecture

```
GitHub  →  [detached fetcher (nohup)]  →  <xdg>/dridock/inbox/<agent>.jsonl
                                                    ↓
                              ┌─────────────────────┴─────────────────────┐
                              ↓                                           ↓
              SessionStart hook drain (catch-up)             Monitor `tail -F -c +N`
              → session context on cold start                → live chat notifications
```

- **Fetcher** (`dridock team watch --inbox <path>`): polls GitHub every
  30s (configurable), writes each surfaced event to the inbox as one
  JSONL line. Detached via `nohup` from the SessionStart hook —
  survives session teardown, keeps writing to the spool while no
  session is live. Same GH polling / cursor / dedup / predicate as
  stdout-mode; different sink.
- **Inbox** (per-agent JSONL file at
  `<xdg>/dridock/inbox/<agent>.jsonl`): append-only spool. One event
  per line. Per-agent means Bear and Arfy write to DIFFERENT files —
  starvation between agents impossible by construction.
- **SessionStart hook** (`team-watch-session-start.sh`): three
  responsibilities per session start:
  1. Ensure fetcher is running (`pgrep` + cmdline check; `nohup`-spawn
     if not).
  2. Drain unread inbox slice `[last_offset, EOF)` into stdout — Claude
     Code injects that as session context.
  3. Print the exact Monitor arm command `tail -F -c +$((EOF+1))
     <inbox>` for Claude to run.
- **UserPromptSubmit hook** (`team-watch-user-prompt-submit.sh`): fires
  per turn to make silent-degrade impossible mid-session:
  - Fetcher liveness (with 60s respawn backoff).
  - Consumer liveness (self-heal if inbox grew but no tail is reading).

## Canonical inbox line format

One JSON object per line, no trailing whitespace, no comment lines.
All fields are strings unless noted; `recipients` is an array of
strings (possibly empty for broadcast).

| Field         | Type       | Source                        | Notes |
|---------------|------------|-------------------------------|-------|
| `observedAt`  | ISO-8601   | source adapter                | When the source first saw the event. NOT the fetcher's clock — this comes from GitHub's `created_at` etc. so cursors + observed times align. |
| `source`      | enum       | adapter                       | Currently only `"github"`; `"consult"`, `"bug-report"`, `"a2a"` reserved. |
| `kind`        | enum       | adapter                       | `"comment"` (message-body event) or `"state-change"` (status flip). |
| `ref`         | string     | adapter                       | Stable identifier for the underlying thing, scoped by source: `github:#46#comment-511010`, `github:#56#body`, `consult:abc123`. |
| `sender`      | string     | parsed message header         | Agent name, or `"<legacy>"` for a body without a header prefix. |
| `recipients`  | `string[]` | parsed message header         | Empty array = broadcast; otherwise the agents/human explicitly targeted. |
| `summary`     | string     | source adapter                | First-line-or-so of the body, truncated by the ADAPTER not the delivery layer. This is what surfaces as chat context. |
| `fingerprint` | string     | `eventHashOf(source, ref, kind, body)` | Stable content hash used for dedup across live↔catch-up overlap. |
| `url`         | string     | derived; optional             | Browsable GitHub URL when the source is `"github"` and the ref matches `github:#<issue>#(body\|comment-<id>\|head)`. Omitted for other sources. |

Example line (whitespace added for readability — real lines are
compact single-line JSON):

```json
{
  "observedAt": "2026-07-29T00:04:08Z",
  "source": "github",
  "kind": "comment",
  "ref": "github:#46#comment-5111100124",
  "sender": "Arfy",
  "recipients": ["Bear"],
  "summary": "Design accepted…",
  "fingerprint": "7f3c1d2e4b5a6c8f",
  "url": "https://github.com/aberezin/docker-claudebox/issues/46#issuecomment-5111100124"
}
```

The canonical parser is
`services/InboxSink.ts:parseInboxLine`; the canonical writer is
`formatInboxLine` in the same file. Host-side tooling should either
use those directly (via the shipped binary) or match their behavior
byte-for-byte.

## File conventions

All paths live under `<xdg>/dridock/inbox/` where `<xdg>` is
`$XDG_CONFIG_HOME` or `$HOME/.config`. All are per-agent (one set per
value of `$DRIDOCK_AGENT_NAME`).

| Path                              | Written by            | Purpose |
|-----------------------------------|-----------------------|---------|
| `<agent>.jsonl`                   | fetcher               | The spool — one JSONL event per line, append-only. |
| `<agent>.jsonl.pid`               | fetcher (boot)        | One-line PID file. Removed on clean shutdown. |
| `<agent>.jsonl.log`               | fetcher (via nohup)   | Combined stdout+stderr. Startup config, poll-failure warnings, sink-write errors. |
| `<agent>.jsonl.session-cursors.json` | SessionStart + UPS  | `{session_id: last_drained_byte_offset}` — per-session drain cursor. |
| `<agent>.jsonl.respawn-stamp`     | UPS                   | Unix epoch of last respawn attempt (for 60s backoff). |

Host + container both use the same path convention (`$HOME/.config/dridock/...`),
but note the persistence caveat below.

## State persistence (known gap)

**The container's `$HOME/.config` is not currently bind-mounted from
the host.** Only `~/.claude`, `~/.ssh`, `~/framework-bugs`,
`~/framework-consult` are (verified via `mount | grep home/claude` in
a running container as of 2026-07-29).

Consequence for delivery: the fetcher's cursor state at
`<xdg>/dridock/watch-cursors/github.state.json` lives on the ephemeral
container FS and is wiped when the container is recreated
(`dridock down && dridock start` post `make build`). On next spawn the
fetcher hits `GithubWatchSource.ts:54` with an empty cursor → maps to
`nowIso()` → **events posted during the container-down window are
lost.** The heartbeat file, dedup ring, and inbox itself share the
same fate.

The inbox spool being non-persistent doesn't help either: even if the
cursor survived, an ephemeral inbox means SessionStart's drain cursor
in `<inbox>.session-cursors.json` is also fresh, so a first-boot
session sees an empty drain regardless.

Two orthogonal fixes possible:

1. **Move state under `~/.claude/`** (bind-mounted → persists). Cleanest
   for the fetcher-only use case — inbox, cursor, pidfile, log all
   under `~/.claude/dridock/inbox/`. Requires updating `xdgRoot()` or
   introducing a dedicated state-dir env var.
2. **Add `~/.config` to the entrypoint's bind-mount set.** Broader
   fix — every claudebot workload storing state under XDG_CONFIG_HOME
   gains persistence for free. Bigger surface + coordination cost.

Tracked as a follow-up. Until then: **do not treat the team-bus as a
guaranteed message queue across container rebuilds.** The dedup ring
still prevents double-delivery within a session, but events posted
during a rebuild window are unrecoverable.

## Fetcher lifecycle

The fetcher is spawned by the SessionStart hook via
`nohup dridock team watch --inbox "$INBOX" >>"$LOG" 2>&1 & disown` and
lives across sessions. Its lifecycle is inspected + controlled through
`dridock team fetcher <sub>`:

| Verb                  | Behavior                                                     | rc   |
|-----------------------|--------------------------------------------------------------|------|
| `fetcher status`      | Read pidfile + verify liveness (kill -0 + cmdline match)     | 0=alive, 1=stale, 2=no pidfile |
| `fetcher stop`        | Cmdline-verify then SIGTERM the pid, remove pidfile          | 0 on success (or if already gone) |
| `fetcher log [--lines N]` | Tail of stderr log (default 40 lines)                    | 0=printed, 2=no log |

Liveness is a two-part check (spec [#56 open loop
#4](https://github.com/aberezin/docker-claudebox/issues/56)): `kill(pid, 0)`
AND `ps -p <pid> -o command=` must contain BOTH "dridock team watch"
AND the inbox path. Without the cmdline check, a post-reboot pid held
by an unrelated process would false-positive-alive — silent starvation
with a green light on `fetcher status`.

## Failure modes and how they surface

None of these are silent — the whole design is built around loud
failure.

| Failure                                     | Where it surfaces                                          |
|---------------------------------------------|------------------------------------------------------------|
| Fetcher never spawned (pre-4.2.0 binary)    | Version gate at hook top: `⚠ team-watch: installed dridock binary predates 4.2.0` |
| Fetcher spawn attempted but crashed at boot | SessionStart hook: `⚠ team fetcher: spawn attempted but pid not alive OR cmdline mismatch` + last 3 log lines |
| Fetcher died mid-session                    | UserPromptSubmit: respawn (60s backoff) + last log line surfaced |
| Wraparound pid held by unrelated process    | Cmdline check rejects; treated as dead → respawn           |
| Session-cursors state file corrupt/absent   | SessionStart falls back to CURRENT EOF (never replay-all) + stderr note |
| Monitor not armed but events landing        | UserPromptSubmit prints delta events in-line + re-prints arm command |
| Poll to GitHub failed (rate limit, etc.)    | Fetcher's `onPollFailed` → stderr → log; cursor doesn't advance, next tick retries |

## Not in scope (deferred to later releases)

- **Rotation**: the inbox is unbounded. At the current post rate (<100 posts/day) this is fine for years; when it becomes a problem we add size-based rotation with a session-cursor migration.
- **Multi-repo per agent**: today the fetcher polls one repo (from the roster's `github_repo`). Multiple rosters / cross-repo watching would need per-repo cursors.
- **Backfill smoke-testing**: a fresh fetcher's cursor starts at "now" (`GithubWatchSource.ts:54`), never replay-history — matches the never-replay-all rule but means you can't smoke-test a fresh install against existing traffic. Document, not fix.

## See also

- [agent-teams.md](agent-teams.md) — named agents, roster, header
  grammar, delivery predicate.
- [convenience-scripts.md](convenience-scripts.md) — `cb-*` /
  `dridock <verb>` convention.
- [#56](https://github.com/aberezin/docker-claudebox/issues/56) — the
  incident + full design conversation.

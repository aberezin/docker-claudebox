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
- **SessionEnd hook** (`team-watch-session-end.sh`, #70): container-only
  (`[ -f /.dockerenv ]`). Fires `dridock team fetcher stop` so the fetcher
  exits cleanly inside Claude's teardown window rather than being SIGKILL'd
  when PID 1 goes away. A no-op on the host by design — see the inverse
  lifecycle note in #70/#71.
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
| `<agent>.jsonl.version`           | SessionStart          | dridock version that spawned the RUNNING fetcher (#71). Compared against the installed binary; a mismatch triggers stop+respawn so watcher fixes take effect. **Host-only** — gated on `[ ! -f /.dockerenv ]`, since the container's fetcher dies with the session and its shim rejects `--version`. |

## Heartbeat (`<xdg>/dridock/watch-cursors/github.heartbeat`)

Written by the fetcher on every tick — the staleness signal the catch-up layer checks to
detect a silently-dead watcher. Shape:

```json
{"source":"github","kind":"polled","seen":39,"surfaced":22,"skipped":17,
 "elapsedMs":956,"atIso":"...","self":"Arfy","repo":"owner/name","inbox":"..."}
```

| field | meaning |
|---|---|
| `seen` | events the source returned this tick (pre-dedup, pre-predicate) |
| `surfaced` | events that reached the sink (the inbox) |
| `skipped` | events the **predicate rejected** (#56) |
| `atIso` | tick time — freshness is what makes this a heartbeat |

`skipped` exists because `surfaced: 0` could not distinguish *"nothing arrived"* from
*"something arrived and was filtered out"*, and those imply completely different actions.
That ambiguity is how #65's headerless merge note read as a quiet poll (`seen: 1,
surfaced: 0`) for a week.

It counts **predicate rejections only** — dedup skips are excluded deliberately, since
counting them would grow the number on every re-poll of a window and turn the signal into
noise, which is how a diagnostic dies.

## State persistence

Persistence works on both sides, but the mechanism is asymmetric:

- **Host (macOS)**: `~/.config` is machine-wide; state at
  `~/.config/dridock/inbox/<agent>.jsonl` (and the sibling
  cursors/pidfile/log) persists across Claude Code restarts and Mac
  reboots as an ordinary file.
- **Container**: the container's `~/.config` is on the ephemeral
  container FS (only `~/.claude`, `~/.ssh`, `~/framework-bugs`,
  `~/framework-consult` are bind-mounted). Fix (#58, v4.2.1):
  `entrypoint.sh` sets `XDG_CONFIG_HOME=/home/claude/.claude/xdg-config`
  at boot — a subdir of the already-bind-mounted `~/.claude/`. Every
  XDG-consuming subsystem in-container (team-watch state, `gh` config,
  bun cache, etc.) automatically persists across
  `dridock down && dridock start` recreates via the existing mount, no
  new mount or code changes required.

So the on-disk paths differ slightly (`~/.config/dridock/...` on host vs
`~/.claude/xdg-config/dridock/...` in container), but both are stable
per-agent locations that survive teardown. The **agreement is
functional, not path-level** — documented explicitly here rather than
claiming they're identical.

### Consequence: XDG state is now persistent host-side

The container's `~/.claude/xdg-config/` is a subdir of the bind-
mounted `~/.claude/`, so anything the container writes under
`XDG_CONFIG_HOME` lands on the host at
`~/.config/dridock/projects/<id>/claude/xdg-config/…`. This is the
whole point for team-watch state — but it also means:

- **`gh` CLI OAuth tokens** in `xdg-config/gh/hosts.yml` — persist.
- **Anything else XDG-consuming inside the container** (bun cache,
  language-server configs, etc.) — persist.

`entrypoint.sh` chmod's `~/.claude/xdg-config/` to 0700 so the whole
subtree is owner-only readable from the host side, matching the
CLAUDE.md rule that credential-carrying files (and their parents)
are not world-visible. Individual sensitive files like `gh/hosts.yml`
retain their tool's chmod (gh uses 0600); the 0700 parent means
another host uid can't even traverse the tree.

If you're storing a NEW kind of credential in-container, you now
choose between: (a) tool-provided XDG storage (persists, owner-only,
same footing as `gh`); (b) `~/.claude/.<container>-secrets` sidecar
(the framework's existing credential channel — see the "Secrets"
section of the top-level `CLAUDE.md`).

**Loud fresh-start signal**: when the fetcher spawns with an empty
cursor (first-ever install, or state-loss for any reason),
`TeamCommand.runWatch` prints a `⚠️ FRESH START — no prior cursor`
warning to stderr → the fetcher's log file. Historical events posted
before that timestamp are NOT replayed (the alternative — deep
backfill of a potentially huge inbox — is worse). The warning makes
the "starting fresh" case visible instead of silent, so operators can
tell the difference between "empty inbox because nothing was posted"
and "empty inbox because state was reset."

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
| Monitor not armed and inbox EMPTY           | UPS still reports it (#56). The liveness check runs BEFORE the nothing-new early exit — otherwise a dead channel with no traffic is indistinguishable from a healthy idle one, and the reminder is missing at the moment it matters most: a fresh session, before anything has arrived. |
| Container fetcher SIGKILL'd at teardown     | SessionEnd hook (`team-watch-session-end.sh`, #70) fires `dridock team fetcher stop` so the fetcher's own SIGTERM handler persists state. **Container-only** — gated on `[ -f /.dockerenv ]`; on the host the fetcher SHOULD outlive the session, which is what lets events accumulate for the next drain. |
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

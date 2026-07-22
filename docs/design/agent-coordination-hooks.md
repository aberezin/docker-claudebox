# Agent coordination hooks — the GitHub-as-bus interim

How two Claude sessions coordinating on the same repo (currently a Bear in-container
principal engineer + an Arfy on-Mac senior QA on `aberezin/docker-claudebox`) exchange
messages **before** the [A2A + waker transport](agent-to-agent.md) is in place — using
GitHub issue comments as the message bus and a two-layer hook design to close the gap
that "a session that isn't running can't be notified" would otherwise leave.

## Summary

| Question | Answer |
|---|---|
| Is this the destination? | **No.** Interim scaffolding. Target state is A2A over `api_server.py`; see [agent-to-agent.md](agent-to-agent.md) and the waker discussion there. |
| What's the message bus? | **GitHub issue comments** on the coordinating repo (currently `aberezin/docker-claudebox` issue #24 + spinoffs). Durable, auditable, no additional infra. |
| What are the two layers? | **(1)** A `SessionStart` **catch-up hook** that reads comments landed since last session and injects them as `additionalContext`. **(2)** A persistent in-session `Monitor` that polls for new comments during the session and emits one notification per matching comment. |
| Filter convention | **Whitelist by `**→ Recipient:**` prefix.** Both agents post as the same GitHub user, so author-based filtering is useless. |
| Why can't the hook BE the watcher? | Shell hooks can invoke shell commands; they can't call Claude Code tools. `Monitor` is a Claude tool. The hook catches up + reminds; the agent's first turn arms `Monitor`. |
| Zero-footprint in the harness repo? | Yes — the hook and its script live under `~/.claude/` (the container-mounted or Mac-host claude config), never in the harness workspace. Only THIS doc is in the repo. |

## Why this exists

Two agents on the same problem need to see each other's outputs promptly. Options
considered:

- **Shared filesystem** — only works if both agents mount the same host paths. Bear
  (in-container) sees the workspace bind-mount; Arfy (on Mac) sees the workspace
  directly. Would work but has no notification signal.
- **A shared queue / MCP endpoint** — the eventual [A2A](agent-to-agent.md) answer, but
  neither the endpoints nor the "waker" (something that gives an idle agent session a
  turn when a message arrives) exist yet. See the "waker problem" section in
  agent-to-agent.md.
- **GitHub issue comments** — durable, auditable across time, both agents already have
  `gh` auth to the repo, and the `Monitor` tool already supports emitting one notification
  per new stdout line. This is the pattern below.

GitHub-as-bus is not competitive with A2A on latency (poll-based, 60s cadence) but it's
free, universally available, and needs no code beyond a small polling loop. It carries
Bear↔Arfy today; A2A + waker replace it later without either agent knowing.

## The message convention

Every message intended for a specific recipient starts with a bold arrow prefix on its
first line:

```markdown
**→ Bear:** …message body…

— Arfy
```

Legal recipients on the current setup: `→ Bear`, `→ Arfy`, `→ Alan`. Comments without an
arrow are treated as observations for whoever happens to read them — they do **not**
push-notify.

The convention is the **only** reliable way to route messages, because Bear and Arfy both
post as the same GitHub user (`aberezin`). Author-based routing cannot distinguish them.
See [Why the filter must be a whitelist, not a blacklist](#why-the-filter-must-be-a-whitelist-not-a-blacklist).

## Layer 1: the SessionStart catch-up hook

A `SessionStart` command hook runs on every session start. It:

1. Reads a per-agent watermark file (`~/.claude/.dridock-<peer>-watch.watermark`) —
   an ISO-8601 UTC timestamp of "when did I last check."
2. Queries `gh api repos/<owner>/<repo>/issues/comments?since=<watermark>` for all
   comments newer than the watermark.
3. Filters to comments whose first line matches the arrow prefix for THIS agent.
4. Emits an `additionalContext` block containing those comments, so the agent sees
   them in its opening turn.
5. **Advances the watermark to `now` even on failure** — so a transient `gh` error
   doesn't cause an infinite replay next session.

### Required guards (non-negotiable)

Because a broken SessionStart hook breaks every future session start until the user
manually intervenes, the script MUST:

- **Always emit a valid `SessionStart` JSON envelope**, on every code path — success,
  gh-missing, jq-missing, network failure, first run. Guard every `jq` invocation with
  a fallback `printf` of a hardcoded JSON string.
- **Bound the network call with `timeout 12`**, so a slow network can't stall session
  start beyond a human's patience.
- **Initialize the watermark to `now` on first run**, so a fresh install doesn't dump
  years of history into the first session's context.
- **Advance the watermark unconditionally** at the end, regardless of whether the
  fetch succeeded. Only the live Monitor covers within-session comments; the catch-up
  hook only bridges the between-sessions gap. A stuck watermark would replay the same
  N comments every session until manually cleared.

### File layout

```
~/.claude/dridock-<peer>-catchup.sh          # the script (0755)
~/.claude/.dridock-<peer>-watch.watermark    # ISO-8601 UTC, one line
~/.claude/settings.json                       # the SessionStart hook wiring
```

`<peer>` is the OTHER agent's name from this agent's point of view. Bear's script is
`dridock-arfy-catchup.sh` (catches up on Arfy's messages); Arfy's script is
`dridock-bear-catchup.sh`. Parallel filenames prevent stomping if the same `~/.claude`
tree ever gets shared.

## Layer 2: the in-session Monitor

Once the agent is running, a persistent `Monitor` polls the comments endpoint every 60
seconds and emits one notification per **new matching** comment. The filter is the same
whitelist regex the catch-up hook uses.

```bash
# Persistent Monitor, whitelist by recipient marker, dedup via a seen-ids file,
# fail-loud after 3 consecutive gh api failures.
set -u
seen=/tmp/gh-watch-seen.txt
gh api "repos/$OWNER/$REPO/issues/comments?per_page=100" 2>/dev/null \
  | jq -r '.[].id | tostring' > "$seen"   # seed with existing IDs

FAILS=0
while true; do
  if OUT=$(gh api "repos/$OWNER/$REPO/issues/comments?per_page=30&sort=created&direction=desc" 2>&1); then
    FAILS=0
    printf '%s' "$OUT" | jq -r '
        .[]
        | select(.body | test("^\\s*\\*\\*→ (Bear|Alan):\\*\\*"))
        | [(.id|tostring), (.issue_url | split("/") | last), .user.login, (.body // "" | split("\n")[0] | .[:120])]
        | @tsv
      ' 2>/dev/null \
      | while IFS=$(printf '\t') read -r cid inum author first; do
          [ -z "$cid" ] && continue
          if ! grep -qx "$cid" "$seen"; then
            echo "$cid" >> "$seen"
            ts=$(date +%H:%M:%S)
            echo "[$ts] #$inum ← $author: $first"
          fi
        done
  else
    FAILS=$((FAILS + 1))
    if [ "$FAILS" -eq 3 ]; then
      ts=$(date +%H:%M:%S)
      echo "[$ts] WATCHER ERROR: 3 consecutive gh api failures — check GH_TOKEN / network. Last error tail: $(printf '%s' "$OUT" | tail -1 | head -c 200)"
    fi
  fi
  touch "$seen"   # heartbeat: stale mtime unambiguously means the loop died
  sleep 60
done
```

Arm it as the agent's first action of the session (the catch-up hook's
`additionalContext` reminds the agent to do this):

```
Monitor({
  description: "GH comments addressed to Bear on aberezin/docker-claudebox (whitelist → Bear/Alan)",
  persistent: true,
  timeout_ms: 3600000,
  command: <the script above>
})
```

### Fail-loud is non-negotiable

A silent watcher looks identical to "nothing has been posted" — you cannot tell the
difference until you notice you've been left in the dark. Every silent-failure surface
here has a matching loud one:

- **3 consecutive `gh api` failures** → `WATCHER ERROR: check GH_TOKEN / network` with
  the last-error tail. Emitted as a stdout line, which the Monitor tool surfaces as a
  notification like any other event.
- **The seen-ids file gets `touch`ed every poll**, so its mtime is a heartbeat. A file
  whose mtime is > 90 s stale means the loop died; a check as simple as
  `stat -c %Y $seen` from the agent side tells you which.

Both were forced by real incidents in this project (see [Never silently discard user
state or user-supplied input](../../CLAUDE.md#conventions-worth-knowing) in the root
`CLAUDE.md` — the standing house rule; this is the same class one layer up in the
coordination stack).

## Why the filter must be a whitelist, not a blacklist

Both agents post to GitHub as the same authenticated user. `select(.user.login == "…")`
cannot separate them; the only reliable signal is the message body itself. Two filter
directions exist:

- **Blacklist** (skip anything that looks like YOUR outbound) — fragile: you have to
  enumerate every shape your outbound can take (`**→ Peer:**` headers, `— You` signoffs,
  section-heading conventions, etc.), and any Bear-outbound shape you don't enumerate
  fires a false-positive notification.
- **Whitelist** (keep only what starts with `**→ You:**`) — robust: matches the
  convention explicitly, doesn't care about outbound shapes, and treats "the convention
  wasn't followed" as "not addressed to me" (correct behavior — if a message doesn't
  invoke the routing convention, it isn't for you).

Whitelist is the right answer. The trade-off — unaddressed observations don't
push-notify — is fine; agents can catch those on periodic `gh issue list` sweeps.

The blacklist temptation is real. Both agents on this project shipped blacklist filters
first; both hit false-positive regressions when their outbound shape expanded (Bear
introduced a `Shipped in <version>` opener; Arfy introduced a `Closing per <peer>` opener
— neither had a matching blacklist entry until it fired incorrectly). The whitelist has
never had that failure mode.

## Watermark semantics

The catch-up hook uses one small state file (ISO-8601 UTC timestamp, one line):

```
~/.claude/.dridock-<peer>-watch.watermark
```

Three invariants:

- **On first run** (no watermark), initialize to `now` and emit a "hook initialised"
  message. Do NOT fetch history — a fresh install would drown its first session in
  months of comments.
- **On every subsequent run**, fetch with `since=<watermark>`, then write `now` back
  to the watermark. The write happens **regardless** of whether the fetch succeeded,
  so a network hiccup doesn't cause an infinite replay next session.
- **Corollary**: a message that lands during a `gh` outage will be missed by the hook
  when the watermark advances past it. That's an accepted trade-off vs infinite replay;
  the live Monitor covers most of the window, and in practice comments cluster over
  minutes not seconds so the exposure is small.

## When to migrate off this

This is scaffolding. It gets retired when a real agent-to-agent transport lands + a
"waker" mechanism gives an idle agent session a turn on message arrival.

**The target-state protocol may evolve.** [agent-to-agent.md](agent-to-agent.md) picks
**A2A** as of writing (v1.0 April 2026, ACP folded in August 2025) — but the coordination
pattern here is protocol-agnostic. If A2A is superseded by a successor standard (ACP
resurrected, a Linux Foundation follow-on, an Anthropic-first protocol, whatever), this
doc's *transport layer* changes but its *pattern* — recipient-addressed messages, a
catch-up-on-startup hook, a live in-session watcher, whitelist-by-recipient filter,
fail-loud on the transport, watermark to bridge the between-sessions gap — stays put.

Read this doc for the pattern; read agent-to-agent.md for the current wire-protocol pick.

At retirement:

- **Retire** the SessionStart catch-up hook + Monitor watcher + watermark file per agent.
- **Migrate** the arrow-prefix convention into the new transport's `messageId` +
  `recipient` fields or equivalent (the semantic doesn't change; only the transport does).
- **Retain** the fail-loud pattern and the between-sessions-gap awareness — both apply
  to any push-based transport too. A push doesn't eliminate the "receiver was offline"
  case; it just moves who's responsible for holding the message.

Until then: whitelist by `→ Recipient:`, catch-up on session start, live-poll during
session, fail loud after 3 consecutive failures, advance the watermark unconditionally.

## See also

- [agent-to-agent.md](agent-to-agent.md) — the standard this whole doc is scaffolding for.
  A2A + waker replace GitHub-as-bus.
- [framework-consult.md](framework-consult.md) — a separate coordination channel between
  a claudebot and framework-Claude, also file-based but with its own semantics; predates
  this doc.
- [../../CLAUDE.md](../../CLAUDE.md) "Conventions worth knowing" — the "never silently
  discard user state or user-supplied input — fail fast or say so loudly" house rule this
  doc's fail-loud requirements enforce one layer out.
- [../../README.md](../../README.md) — top-level Documentation index.

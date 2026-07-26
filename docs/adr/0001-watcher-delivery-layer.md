# ADR 0001 — Watcher delivery layer: polling now, Channels deferred

- **Status:** Accepted — 2026-07-26 (Alan)
- **Deciders:** Alan, with Bear + Arfy analysis (#45, #49)
- **Supersedes:** the "adopt Channels as the in-session layer" leaning in #45's prior-art comment.

## Context

The reusable agent watcher (#45, spec in [`../design/agent-teams.md`](../design/agent-teams.md)) needs an
**in-session delivery layer**: the mechanism that gets an inbound event (a GitHub comment addressed
to an agent, a consult reply, a bug-report status change) *in front of a running Claude Code agent*.

Two candidates were evaluated:

1. **Polling** — a persistent in-session `Monitor` that polls `gh api …/issues/comments` every ~60s
   and surfaces matches. This is what Bear↔Arfy run today; it works.
2. **Claude Code Channels** (research preview) — an MCP server that *pushes* a `<channel>` event
   directly into a running session (real-time), which would replace polling.

Channels was researched and spiked hands-on in **#49**. Findings below.

## Decision

**Ship the channel-less (polling-Monitor) delivery layer. Do not adopt Channels until it is GA.**

The rest of #45 — the event schema, cross-layer dedup, heartbeat, and the `Sender->Recipient:`
delivery predicate — is **transport-agnostic** and proceeds unchanged. A future switch to Channels
is a *delivery-layer swap only*, not a redesign.

## Rationale

- **Channels is a research preview.** The `--channels` flag syntax and the protocol contract "may
  change based on feedback." Building a shipping dependency on an unstable preview is premature.
- **Headless activation is unproven — the make-or-break for our agents.** Bear (container) and Arfy
  (host) run Claude **non-interactively** / under `--dangerously-skip-permissions`. In the #49 spike
  a dev channel did **not** activate under `-p` (the channel MCP server never spawned — the
  `--dangerously-load-development-channels` flow needs an interactive confirmation dialog). Whether a
  channel loads under dridock's specific headless spawn is untested and container-side.
- **No delivery guarantee to lean on.** Channel notifications are **fire-and-forget, not
  acknowledged**; if the session isn't listening they are **dropped silently**; there is **no
  auto-reconnect**. So even with Channels we would have to build our own receiver-side keepalive/ack
  (#50) — the transport buys us less than it first appears.
- **Polling works today** with zero preview dependency and acceptable latency for this use case
  (~60s; the coordination bus is not latency-critical).

### Why revisit later (what Channels *would* buy)

- **Real-time push** vs. ~60s poll.
- A **two-way reply tool**: the agent can reply *back through* the channel — a genuine agent↔agent
  path, not just inbound delivery.

## Consequences

- Delivery latency stays at the polling interval (~60s). Accepted.
- The watcher keeps the 3-layer shape (live poll + catch-up + heartbeat) with no channel plumbing.
- The **receiver-side sender-gating security rule** (agent-teams.md §3) still applies to *any* future
  push transport: an ungated channel is a prompt-injection vector, so the delivery predicate must run
  in the receiver **before** injection.
- Because the delivery layer is isolated behind the source-adapter/event-schema contract, adopting
  Channels later touches only that layer.

## Preserved analysis — the #49 Channels characterization

Kept here so a future GA revisit does not re-research from zero. (Full thread: #49.)

- **What a channel is:** an MCP server (Bun/Node/Deno + `@modelcontextprotocol/sdk`) declaring
  `capabilities.experimental['claude/channel']={}`, connected over **stdio** (Claude Code spawns it),
  that calls `mcp.notification({method:'notifications/claude/channel', params:{content, meta}})`.
- **Our exact fit:** the official *"build a webhook receiver"* example *is* the GitHub channel we'd
  want — a local HTTP listener whose POST body becomes the event. ~30 lines. A GitHub poller/webhook
  POSTs the comment; it's injected.
- **Message contract:** arrives as `<channel source="…" attr="…">content</channel>`; terminal shows
  `← source: content`. `meta` keys become tag attributes (identifiers only — hyphens dropped).
  Events queue in order; batched if the agent is mid-turn.
- **Availability:** research preview; flags (`--channels`, `--dangerously-load-development-channels`)
  are **hidden from `claude --help` but functional** (confirmed on v2.1.220). Needs claude.ai or
  Console API-key auth (not Bedrock/Vertex). Pro/Max: per-session opt-in; Team/Enterprise: admin
  `channelsEnabled` + optional `allowedChannelPlugins`. Custom channels aren't on the allowlist —
  dev-tested via `--dangerously-load-development-channels`, shipped by packaging as an allowlisted
  plugin.
- **Reliability:** fire-and-forget, unacknowledged, silent-drop if unlistened, no auto-reconnect
  (a crashed channel shows "Failed to connect" in `/mcp`). Session **must be running** — Channels are
  in-session delivery, **not** an out-of-session waker.
- **Security:** an ungated channel is a prompt-injection vector — the receiver MUST sender-gate
  before pushing.

## Remaining testing (do before any GA adoption)

1. **Interactive live-injection observation** (host/Arfy) — open
   `claude --dangerously-load-development-channels server:webhook`, `curl` a message in, confirm the
   `<channel>` tag injects into a live session and measure latency. Scratch channel is kept at
   `scratchpad/webhook-channel/` (`webhook.ts` + `.mcp.json`).
2. **Container headless load-test** (container/Bear) — spawn a claudebot under
   `--dangerously-skip-permissions` with a scratch channel registered in `.mcp.json`; probe `/mcp`
   status. This is the make-or-break gate: if channels don't load headless in the container, the
   Channels upgrade is host-only at best.
3. **Channel-liveness keepalive** (#50) — a receiver-side keepalive/ack so a silently-broken channel
   is detectable (option A; option B "rely on Channels' reliability" does not exist).
4. **Re-evaluate when Channels reaches GA** — recheck the flag/protocol contract for changes.

## References

- #45 — reusable watcher design (delivery predicate, event schema, dedup, heartbeat).
- #49 — the Channels characterization spike (source of the preserved analysis).
- #50 — channel-liveness keepalive (a hard requirement *if* Channels is adopted).
- [`../design/agent-teams.md`](../design/agent-teams.md) — the agent-teams spec §3 delivery predicate + the receiver-side-gating security rule.
- [Claude Code Channels](https://code.claude.com/docs/en/channels.md) · [Channels reference](https://code.claude.com/docs/en/channels-reference).

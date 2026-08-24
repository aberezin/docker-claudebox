import type { WatcherEvent } from "./WatcherEvent.ts";
import type { WatchSource } from "./GithubWatchSource.ts";
import { WatcherStore, type WatcherStoreState } from "./WatcherStore.ts";
import { surfacesForAgent } from "./AgentTeamHeader.ts";

/**
 * The orchestrator that composes every #45 delivery primitive into a
 * single testable unit. Pure — no CLI, no signal handling, no
 * side effects beyond what the injected `store` + `sink` do. The
 * `dridock team watch` verb (#46.d.3b) wraps this with the live-loop
 * timer, heartbeat file, and Ctrl-C handling.
 *
 * ## One poll cycle
 *   1. Load persisted state (cursor + delivered ring-buffer).
 *   2. Call `source.poll(state.cursor)` — soft-fails return a
 *      `poll-failed` outcome the sink is told about + the cursor
 *      is NOT advanced (retry next tick).
 *   3. For each event, in observedAt order:
 *      a. Skip if `state.delivered` already has its hash (dedup —
 *         the live↔catch-up overlap case).
 *      b. Skip if `surfacesForAgent(event.header, selfName)` is false
 *         (recipient filter — the security-boundary predicate from
 *         agent-teams §3).
 *      c. Surface via `sink.onEvent(event)` and mark delivered.
 *   4. Persist the updated state (bumped cursor + new hashes).
 *   5. Report the tick outcome to `sink.onTickComplete()` — the
 *      heartbeat hook the CLI verb uses to write its liveness file.
 *
 * Failure semantics: soft failures from the source (network error,
 * gh rate limit) don't crash the loop — sink is told, cursor doesn't
 * advance, next tick retries.
 */

/** A single sink an application wires up; the CLI hooks stderr into
 *  it. Each method fires per tick. */
export interface WatcherSink {
  /** Fires once per event that survived dedup + predicate. In-order
   *  by `observedAt`. */
  onEvent(event: WatcherEvent): void | Promise<void>;
  /** Fires once per source-poll failure. Called BEFORE the tick ends;
   *  a chatty sink can rate-limit; a strict sink can escalate. */
  onPollFailed?(source: string, reason: string): void | Promise<void>;
  /** Fires once per completed tick regardless of outcome. The
   *  {surfaced, skipped, seen, elapsed} shape is enough to drive a heartbeat
   *  file + optional debug output. */
  onTickComplete?(summary: WatcherTickSummary): void | Promise<void>;
}

export interface WatcherTickSummary {
  readonly source: string;
  readonly kind: "polled" | "poll-failed";
  /** Events the source returned this tick (pre-dedup, pre-predicate). */
  readonly seen: number;
  /** Events that made it all the way to the sink. */
  readonly surfaced: number;
  /**
   * Events the predicate REJECTED this tick (#56).
   *
   * `surfaced: 0` alone cannot distinguish "nothing arrived" from "something
   * arrived and was filtered out" — and those imply completely different
   * actions. That ambiguity is what let #65's merge note vanish for a week:
   * the heartbeat read `seen: 1, surfaced: 0`, which looked like a quiet poll.
   *
   * Counts predicate rejections ONLY. Dedup skips are excluded on purpose:
   * those events were already delivered, so counting them would make the
   * number grow on every re-poll of a window and turn a signal into noise —
   * which is how a diagnostic dies.
   */
  readonly skipped: number;
  /** Wall-clock ms for this tick (start of poll → end of sink calls). */
  readonly elapsedMs: number;
}

export interface WatcherLoopDeps {
  readonly source: WatchSource;
  readonly store: WatcherStore;
  readonly sink: WatcherSink;
  /** `self` agent name — passed to the delivery predicate as `selfName`.
   *  Resolved by the CLI via `resolveSelfName(env, roster)` and passed
   *  in. */
  readonly selfName: string;
  /** Injected in tests to avoid real wall-clock timing in tick summary. */
  readonly now?: () => number;
}

/** Run one poll cycle. The CLI's live-loop calls this in a while(true)
 *  with a sleep between iterations. Returns the summary so the caller
 *  can act on it (e.g. exit on `poll-failed` after N consecutive fails
 *  — the "fail loud" invariant). */
export async function runOneTick(deps: WatcherLoopDeps): Promise<WatcherTickSummary> {
  const nowMs = deps.now ?? (() => performance.now());
  const startMs = nowMs();
  const state = await deps.store.load();
  const outcome = await deps.source.poll(state.cursor);

  if (outcome.kind === "poll-failed") {
    if (deps.sink.onPollFailed !== undefined) {
      await deps.sink.onPollFailed(deps.source.source, outcome.reason);
    }
    const summary: WatcherTickSummary = {
      source: deps.source.source,
      kind: "poll-failed",
      seen: 0,
      surfaced: 0,
      skipped: 0,
      elapsedMs: nowMs() - startMs,
    };
    if (deps.sink.onTickComplete !== undefined) {
      await deps.sink.onTickComplete(summary);
    }
    return summary;
  }

  let nextState: WatcherStoreState = state;
  let surfaced = 0;
  let skipped = 0;
  // Events arrive from the source pre-sorted by observedAt; iterate in
  // that order so the sink sees them chronologically.
  for (const event of outcome.events) {
    if (WatcherStore.isDelivered(nextState, event.eventHash)) continue;
    if (!surfacesForAgent(event.header, deps.selfName)) { skipped++; continue; }
    await deps.sink.onEvent(event);
    nextState = WatcherStore.markDelivered(nextState, event.eventHash, event.cursor);
    surfaced++;
  }

  // Even if nothing surfaced, advance the cursor so we don't re-poll
  // the same window next tick. `outcome.newCursor` is the source's
  // advanced watermark (max(observedAt)+1ms for github).
  await deps.store.save({
    cursor: outcome.newCursor,
    delivered: nextState.delivered,
  });

  const summary: WatcherTickSummary = {
    source: deps.source.source,
    kind: "polled",
    seen: outcome.events.length,
    surfaced,
    skipped,
    elapsedMs: nowMs() - startMs,
  };
  if (deps.sink.onTickComplete !== undefined) {
    await deps.sink.onTickComplete(summary);
  }
  return summary;
}

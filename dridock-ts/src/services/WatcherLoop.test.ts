import { test, expect, describe } from "bun:test";
import { runOneTick, type WatcherSink, type WatcherTickSummary } from "./WatcherLoop.ts";
import { WatcherStore } from "./WatcherStore.ts";
import { eventHashOf, type WatcherEvent } from "./WatcherEvent.ts";
import type { WatchSource, WatchSourcePollOutcome } from "./GithubWatchSource.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { parseHeader } from "./AgentTeamHeader.ts";

// ── fakes ─────────────────────────────────────────────────────────────

/** A programmable WatchSource for tests. Seed the outcome; assert
 *  the cursor it was called with. */
class FakeSource implements WatchSource {
  readonly source = "github" as const;
  readonly calls: string[] = [];
  outcome: WatchSourcePollOutcome = { kind: "ok", events: [], newCursor: "" };

  async poll(fromCursor: string): Promise<WatchSourcePollOutcome> {
    this.calls.push(fromCursor);
    return this.outcome;
  }
}

class RecordingSink implements WatcherSink {
  readonly events: WatcherEvent[] = [];
  readonly failures: { source: string; reason: string }[] = [];
  readonly ticks: WatcherTickSummary[] = [];
  onEvent(event: WatcherEvent): void { this.events.push(event); }
  onPollFailed(source: string, reason: string): void { this.failures.push({ source, reason }); }
  onTickComplete(summary: WatcherTickSummary): void { this.ticks.push(summary); }
}

// ── event builders (thin wrappers around eventHashOf for readability) ─

function ev(input: {
  ref: string;
  body: string;
  observedAt: string;
}): WatcherEvent {
  return {
    source: "github",
    kind: "comment",
    ref: input.ref,
    header: parseHeader(input.body) ?? null,
    summary: input.body,
    eventHash: eventHashOf({ source: "github", ref: input.ref, kind: "comment", salient: input.body }),
    cursor: input.observedAt,
    observedAt: input.observedAt,
  };
}

// ── the tests ────────────────────────────────────────────────────────

const BASE = "/xdg/dridock/watch-cursors";

describe("runOneTick — dedup + predicate composition", () => {
  test("event addressed to self survives predicate + dedup + surfaces", async () => {
    const source = new FakeSource();
    source.outcome = {
      kind: "ok",
      newCursor: "2026-07-26T15:00:01.001Z",
      events: [ev({ ref: "github:#42#comment-1", body: "Arfy->Bear: verified", observedAt: "2026-07-26T15:00:01Z" })],
    };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    const summary = await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(summary).toEqual({ source: "github", kind: "polled", seen: 1, surfaced: 1, elapsedMs: 42 });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.summary).toBe("Arfy->Bear: verified");
  });

  test("event NOT addressed to self is filtered out by the predicate", async () => {
    const source = new FakeSource();
    source.outcome = {
      kind: "ok",
      newCursor: "2026-07-26T15:00:02.001Z",
      events: [ev({ ref: "github:#42#comment-2", body: "Arfy->Alan: for you", observedAt: "2026-07-26T15:00:02Z" })],
    };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    const summary = await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toEqual([]);
    expect(summary.seen).toBe(1);
    expect(summary.surfaced).toBe(0);
  });

  test("self-echo (Bear posts, Bear watches) dropped by sender != self", async () => {
    const source = new FakeSource();
    source.outcome = {
      kind: "ok",
      newCursor: "2026-07-26T15:00:03.001Z",
      events: [ev({ ref: "github:#42#comment-3", body: "Bear->Arfy: my own post", observedAt: "2026-07-26T15:00:03Z" })],
    };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toEqual([]);
  });

  test("broadcast surfaces to everyone but the sender", async () => {
    const source = new FakeSource();
    source.outcome = {
      kind: "ok",
      newCursor: "2026-07-26T15:00:04.001Z",
      events: [ev({ ref: "github:#42#comment-4", body: "Arfy: team-wide FYI", observedAt: "2026-07-26T15:00:04Z" })],
    };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toHaveLength(1);
  });

  test("plain-text body (no header) is dropped (nothing to attribute → not delivered)", async () => {
    const source = new FakeSource();
    source.outcome = {
      kind: "ok",
      newCursor: "2026-07-26T15:00:05.001Z",
      events: [ev({ ref: "github:#42#comment-5", body: "just some regular comment", observedAt: "2026-07-26T15:00:05Z" })],
    };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toEqual([]);
  });
});

describe("runOneTick — dedup enforcement (the live↔catch-up overlap case)", () => {
  test("event whose hash is in delivered → skipped (idempotent re-fire suppressed)", async () => {
    const targetEvent = ev({ ref: "github:#42#comment-6", body: "Arfy->Bear: hi", observedAt: "2026-07-26T15:00:06Z" });
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    // Pre-seed: this hash was already delivered on a prior tick.
    await store.save({ cursor: "2026-07-26T15:00:05Z", delivered: [targetEvent.eventHash] });

    const source = new FakeSource();
    source.outcome = { kind: "ok", newCursor: "2026-07-26T15:00:06.001Z", events: [targetEvent] };
    const sink = new RecordingSink();
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toEqual([]);
    // But the cursor STILL advances so we don't re-poll the same window.
    const persisted = await store.load();
    expect(persisted.cursor).toBe("2026-07-26T15:00:06.001Z");
  });

  test("second identical tick surfaces nothing (dedup persists across calls)", async () => {
    const targetEvent = ev({ ref: "github:#42#comment-7", body: "Arfy->Bear: hi", observedAt: "2026-07-26T15:00:07Z" });
    const source = new FakeSource();
    source.outcome = { kind: "ok", newCursor: "2026-07-26T15:00:07.001Z", events: [targetEvent] };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");

    // First tick — surfaces.
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toHaveLength(1);

    // Second tick — same event returned (as if catch-up re-fetched it).
    // Dedup blocks re-surfacing.
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.events).toHaveLength(1);
  });
});

describe("runOneTick — cursor advancement", () => {
  test("empty poll (no events) → cursor still advances to source.newCursor", async () => {
    const source = new FakeSource();
    source.outcome = { kind: "ok", newCursor: "2026-07-26T15:00:08.001Z", events: [] };
    const sink = new RecordingSink();
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    await store.save({ cursor: "2026-07-26T15:00:00Z", delivered: [] });
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    const persisted = await store.load();
    expect(persisted.cursor).toBe("2026-07-26T15:00:08.001Z");
  });

  test("passes state.cursor to source.poll (source sees the persisted watermark)", async () => {
    const source = new FakeSource();
    source.outcome = { kind: "ok", newCursor: "x", events: [] };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    await store.save({ cursor: "2026-07-26T15:00:00Z", delivered: [] });
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(source.calls).toEqual(["2026-07-26T15:00:00Z"]);
  });
});

describe("runOneTick — soft failure handling", () => {
  test("poll-failed → sink.onPollFailed fired, cursor NOT advanced, tick summary shows failure kind", async () => {
    const source = new FakeSource();
    source.outcome = { kind: "poll-failed", reason: "gh api rc=1" };
    const sink = new RecordingSink();
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    await store.save({ cursor: "2026-07-26T15:00:00Z", delivered: [] });
    const summary = await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(summary.kind).toBe("poll-failed");
    expect(sink.failures).toEqual([{ source: "github", reason: "gh api rc=1" }]);
    // Cursor untouched — retry next tick from the same watermark.
    const persisted = await store.load();
    expect(persisted.cursor).toBe("2026-07-26T15:00:00Z");
  });

  test("poll-failed also fires onTickComplete (heartbeat still needs a signal)", async () => {
    const source = new FakeSource();
    source.outcome = { kind: "poll-failed", reason: "network" };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(sink.ticks).toHaveLength(1);
    expect(sink.ticks[0]!.kind).toBe("poll-failed");
  });
});

describe("runOneTick — tick summary", () => {
  test("onTickComplete fires once with accurate {seen, surfaced, elapsedMs}", async () => {
    const source = new FakeSource();
    const es = [
      ev({ ref: "r1", body: "Arfy->Bear: 1", observedAt: "2026-07-26T15:00:01Z" }),
      ev({ ref: "r2", body: "Arfy->Alan: 2", observedAt: "2026-07-26T15:00:02Z" }), // not for Bear
      ev({ ref: "r3", body: "Arfy->Bear: 3", observedAt: "2026-07-26T15:00:03Z" }),
    ];
    source.outcome = { kind: "ok", newCursor: "2026-07-26T15:00:03.001Z", events: es };
    const sink = new RecordingSink();
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    const summary = await runOneTick({ source, store, sink, selfName: "Bear", now: fakeNow() });
    expect(summary.seen).toBe(3);
    expect(summary.surfaced).toBe(2);
    expect(summary.elapsedMs).toBe(42);
    expect(sink.ticks).toHaveLength(1);
    expect(sink.ticks[0]).toEqual(summary);
  });

  test("sink methods are optional — undefined handlers don't crash", async () => {
    const source = new FakeSource();
    source.outcome = { kind: "ok", newCursor: "x", events: [] };
    const minimalSink: WatcherSink = { onEvent: () => {} }; // no onPollFailed, no onTickComplete
    const store = new WatcherStore(new InMemoryFileSystem(), BASE, "github");
    // Should not throw.
    await runOneTick({ source, store, sink: minimalSink, selfName: "Bear" });
    expect(true).toBe(true);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

/** Deterministic ms clock for elapsedMs assertions. Returns 0, 42, 42, 42, …
 *  (start → end pattern; first call is the "start", second is "end" → 42ms
 *  elapsed). Anything after doesn't matter for the runOneTick contract. */
function fakeNow(): () => number {
  const seq = [0, 42];
  let i = 0;
  return () => (i < seq.length ? seq[i++]! : 42);
}

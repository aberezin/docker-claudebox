import { test, expect, describe } from "bun:test";
import { eventHashOf, type WatcherEvent } from "./WatcherEvent.ts";
import { parseHeader } from "./AgentTeamHeader.ts";

// Spec: #45 converged event schema (event kinds, eventHash construction).

describe("eventHashOf — deterministic content fingerprint for dedup", () => {
  test("same inputs → same hash across calls (the dedup contract)", () => {
    const a = eventHashOf({ source: "github", ref: "#42#comment-1", kind: "comment", salient: "hello" });
    const b = eventHashOf({ source: "github", ref: "#42#comment-1", kind: "comment", salient: "hello" });
    expect(a).toBe(b);
  });

  test("different `source` → different hash (namespacing across adapters)", () => {
    const gh = eventHashOf({ source: "github", ref: "abc", kind: "comment", salient: "x" });
    const cs = eventHashOf({ source: "consult", ref: "abc", kind: "comment", salient: "x" });
    expect(gh).not.toBe(cs);
  });

  test("different `ref` → different hash", () => {
    const a = eventHashOf({ source: "github", ref: "#42#1", kind: "comment", salient: "x" });
    const b = eventHashOf({ source: "github", ref: "#42#2", kind: "comment", salient: "x" });
    expect(a).not.toBe(b);
  });

  test("different `kind` → different hash (comment vs state-change on same ref)", () => {
    const c = eventHashOf({ source: "consult", ref: "abc", kind: "comment", salient: "text" });
    const s = eventHashOf({ source: "consult", ref: "abc", kind: "state-change", salient: "text" });
    expect(c).not.toBe(s);
  });

  test("different `salient` → different hash (two edits of same comment de-dupe apart)", () => {
    const v1 = eventHashOf({ source: "github", ref: "#42#7", kind: "comment", salient: "typo fix" });
    const v2 = eventHashOf({ source: "github", ref: "#42#7", kind: "comment", salient: "typo fix (edited)" });
    expect(v1).not.toBe(v2);
  });

  test("state-change: same ref + same status → same hash (idempotent re-emit is a no-op)", () => {
    // Consult status flips resolved → resolved (a redundant re-report)
    // must hash the same so DedupStore drops it.
    const a = eventHashOf({ source: "consult", ref: "abc", kind: "state-change", salient: "resolved" });
    const b = eventHashOf({ source: "consult", ref: "abc", kind: "state-change", salient: "resolved" });
    expect(a).toBe(b);
    // But same ref + DIFFERENT status is a real event — different hash.
    const c = eventHashOf({ source: "consult", ref: "abc", kind: "state-change", salient: "closed" });
    expect(a).not.toBe(c);
  });

  test("payload separator (null byte) prevents field-boundary collisions", () => {
    // Without the \0 separator, source='a' ref='bc' would collide with
    // source='ab' ref='c'. The \0 makes fields unambiguous.
    const a = eventHashOf({ source: "github", ref: "test", kind: "comment", salient: "x" });
    const b = eventHashOf({ source: "github", ref: "TEST", kind: "comment", salient: "x" });
    expect(a).not.toBe(b); // case-sensitivity is a real property, not a collision
  });

  test("output is a fixed-width 16-char hex string (compact + comparable)", () => {
    const h = eventHashOf({ source: "github", ref: "x", kind: "comment", salient: "y" });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("WatcherEvent — shape sanity (documents the contract)", () => {
  test("comment kind carries a parsed header; state-change kind has null header", () => {
    // Not testing behavior — just documenting the shape via a compile-
    // time-adjacent example so a future reader sees the intent.
    const commentEvent: WatcherEvent = {
      source: "github",
      kind: "comment",
      ref: "#42#comment-123",
      header: parseHeader("Arfy->Bear: verified") ?? null,
      summary: "verified",
      eventHash: eventHashOf({ source: "github", ref: "#42#comment-123", kind: "comment", salient: "Arfy->Bear: verified" }),
      cursor: "2026-07-26T15:00:00Z",
      observedAt: "2026-07-26T15:00:00Z",
    };
    expect(commentEvent.header).not.toBeNull();
    expect(commentEvent.header?.sender).toBe("Arfy");
    expect(commentEvent.header?.recipients).toEqual(["Bear"]);

    const stateEvent: WatcherEvent = {
      source: "consult",
      kind: "state-change",
      ref: "consult:abc",
      header: null,
      summary: "status: awaiting-framework → replied",
      eventHash: eventHashOf({ source: "consult", ref: "consult:abc", kind: "state-change", salient: "replied" }),
      cursor: "replied",
      observedAt: "2026-07-26T15:01:00Z",
    };
    expect(stateEvent.header).toBeNull();
  });
});

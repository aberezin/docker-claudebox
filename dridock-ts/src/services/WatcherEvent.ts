import type { ParsedHeader } from "./AgentTeamHeader.ts";

/**
 * The unified event shape emitted by every #45 source adapter (GitHub
 * comments/issues, cb-consult replies, cb-report-bug notes, future A2A).
 * Consumed by the watcher's delivery layer.
 *
 * Spec: #45 converged event schema (Arfy's post 2026-07-26) — see also
 * docs/design/agent-teams.md §3 for the delivery predicate that branches
 * on `kind`.
 *
 * ## `kind` discriminator
 * - `"comment"` — a message-body event; `header` is set (parsed via
 *   [[parseHeader]] in AgentTeamHeader.ts). Delivery predicate uses
 *   sender/recipients per agent-teams §3.
 * - `"state-change"` — a stateful event (consult status flip, bug-report
 *   resolved→closed, etc.); `header` is `null`. Delivery predicate uses
 *   subscription rather than sender/recipient attribution.
 *
 * ## `eventHash`
 * Stable content fingerprint used by [[DedupStore]] to make the
 * `live↔catch-up` window overlap idempotent (spec point I raised on
 * #45: 3 comments delivered live near teardown that catch-up re-fetches
 * would double-fire without dedup). See [[eventHashOf]] below for the
 * canonical construction — MUST be deterministic across processes so
 * catch-up matches live.
 *
 * ## `cursor`
 * Per-adapter watermark payload. GitHub's is a timestamp string
 * (`?since=<iso8601>`); consult/bug-report's is a last-known-status map
 * per ref. Opaque to the delivery layer — the adapter owns the shape
 * and reads it back on the next poll.
 *
 * ## `observedAt`
 * When the ADAPTER first observed the event. For a GitHub comment this
 * is the comment's `created_at`; the watcher itself does NOT stamp
 * `Date.now()` here (workflow scripts can't call `Date.now()`; runtime
 * scripts shouldn't either — reserves the field for the source's own
 * timestamp so cursors + observed times align).
 */
export interface WatcherEvent {
  readonly source: WatcherSource;
  readonly kind: WatcherEventKind;
  /** Stable identifier for the underlying thing (`"github:#42#comment-123"`,
   *  `"consult:abc123"`, `"bug-report:xyz#status"`). Not URL, not opaque —
   *  scoped by source so consult:abc123 doesn't collide with github:abc123. */
  readonly ref: string;
  /** Parsed message header — set for `"comment"` events, `null` for
   *  `"state-change"`. Predicate branches on this. */
  readonly header: ParsedHeader | null;
  /** First-line-or-so summary for the delivery surface (SessionStart
   *  hook line, stderr notification). Truncated by the ADAPTER, not by
   *  the delivery layer. */
  readonly summary: string;
  /** Content fingerprint for dedup. See [[eventHashOf]]. */
  readonly eventHash: string;
  /** Opaque per-source watermark payload — read by the adapter's next
   *  poll to skip already-seen events. Shape is per-adapter. */
  readonly cursor: string;
  /** ISO-8601 timestamp from the source (not from our clock). Used for
   *  ordering + display. */
  readonly observedAt: string;
}

export type WatcherSource = "github" | "consult" | "bug-report" | "a2a";
export type WatcherEventKind = "comment" | "state-change";

/**
 * Construct the canonical `eventHash` for a candidate event. Purely a
 * function of `(source, ref, kind, salient-content)` — same inputs give
 * the same hash on every process, so `live` and `catch-up` layers
 * running at different times reliably dedup.
 *
 * The "salient-content" varies by kind:
 *   - `"comment"` — the message body (post-header). Two different
 *     comments on the same ref hash differently.
 *   - `"state-change"` — the new status value. Same ref, same status
 *     hashes the same (idempotent re-report is a no-op).
 *
 * Uses Bun's built-in FNV-1a-ish `Bun.hash()` for speed + zero deps.
 * Not cryptographic — dedup only needs collision-resistance at the
 * few-hundred-events-per-source scale.
 */
export function eventHashOf(input: {
  source: WatcherSource;
  ref: string;
  kind: WatcherEventKind;
  salient: string;
}): string {
  // Deterministic serialization — the order matters so a source that
  // shuffles fields can't produce different hashes for the same event.
  const payload = `${input.source}\0${input.kind}\0${input.ref}\0${input.salient}`;
  // Bun.hash returns bigint; render as hex for compact string keying.
  return typeof (globalThis as { Bun?: { hash?: (s: string) => bigint } }).Bun?.hash === "function"
    ? (globalThis as { Bun: { hash: (s: string) => bigint } }).Bun.hash(payload).toString(16).padStart(16, "0")
    : fnv1aFallback(payload);
}

/** Zero-dep FNV-1a-64 fallback for environments without Bun.hash
 *  (matters only in Node test runs of these files — Bun is the prod
 *  runtime). Small, deterministic; not cryptographic. */
function fnv1aFallback(s: string): string {
  let h = 0xcbf29ce484222325n; // FNV offset basis
  const prime = 0x100000001b3n; // FNV prime
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

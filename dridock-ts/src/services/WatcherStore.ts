import type { FileSystem } from "../infra/FileSystem.ts";
import type { WatcherSource } from "./WatcherEvent.ts";

/**
 * Per-source persistent state the watcher needs to survive teardown:
 *   1. **Cursor** — opaque per-source watermark the adapter emits, read
 *      back on the next poll so it skips already-seen events.
 *   2. **Dedup ring-buffer** — bounded set of recently-delivered
 *      `eventHash`es. Makes the live↔catch-up overlap idempotent
 *      (spec point I raised on #45: 3 events delivered live near
 *      teardown that the next catch-up re-fetches would double-fire
 *      without dedup). Count-based cap, not time-TTL, so a paused
 *      laptop + clock drift can't silently expire an in-flight entry.
 *
 * On-disk layout under `<xdg>/projects/<id>/watch-cursors/<source>.state.json`:
 * ```json
 * {
 *   "cursor": "<opaque adapter string>",
 *   "delivered": ["hash1", "hash2", …up to CAP…]
 * }
 * ```
 * Container-side path per my #45 answer to Q3 (per-project); host-side
 * scanning agents (Arfy) use `~/.config/dridock/watch-cursors/<source>.state.json`
 * — the CALLER passes the right directory in `basePath`.
 *
 * All operations are best-effort — a corrupt state file is treated as
 * absent (initial state) rather than throwing. Rationale: watcher
 * failures should degrade to "re-deliver events" not "crash the
 * session-start hook."
 */

export const DEFAULT_DEDUP_CAP = 500;

export interface WatcherStoreState {
  readonly cursor: string;
  /** Newest first — index 0 was the most recently added event. Bounded
   *  by `cap`. */
  readonly delivered: readonly string[];
}

export class WatcherStore {
  constructor(
    private readonly fs: FileSystem,
    /** Absolute directory under which per-source state files live.
     *  Container: `<xdg>/projects/<id>/watch-cursors/`. Host: `<xdg>/watch-cursors/`. */
    private readonly baseDir: string,
    private readonly source: WatcherSource,
    private readonly cap: number = DEFAULT_DEDUP_CAP,
  ) {}

  /** Load the current state — cursor + delivered set. Returns empty
   *  defaults (`cursor=""`, `delivered=[]`) on missing OR corrupt file. */
  async load(): Promise<WatcherStoreState> {
    const path = this.path();
    const text = await this.fs.readTextOrUndefined(path);
    if (text === undefined || text.trim() === "") {
      return { cursor: "", delivered: [] };
    }
    try {
      const parsed = JSON.parse(text) as Partial<WatcherStoreState>;
      const cursor = typeof parsed.cursor === "string" ? parsed.cursor : "";
      const delivered = Array.isArray(parsed.delivered)
        ? parsed.delivered.filter((h): h is string => typeof h === "string").slice(0, this.cap)
        : [];
      return { cursor, delivered };
    } catch {
      // Corrupt state file — treat as absent. Watcher's next poll
      // re-fetches from the beginning of the cursor window, dedup
      // starts fresh. Worst case: duplicate delivery of events the
      // catch-up layer would have suppressed — not a correctness bug,
      // just a one-time UX blip.
      return { cursor: "", delivered: [] };
    }
  }

  /** Save the state atomically. Uses `writeTextAtomic` so a power-cut
   *  mid-write can't leave a truncated file. */
  async save(state: WatcherStoreState): Promise<void> {
    await this.fs.mkdirRecursive(this.baseDir);
    // Cap `delivered` at the ring-buffer boundary before persisting so
    // the file never grows without bound. Newest-first ordering means
    // slicing from the head keeps the most-recent entries.
    const bounded: WatcherStoreState = {
      cursor: state.cursor,
      delivered: state.delivered.slice(0, this.cap),
    };
    await this.fs.writeTextAtomic(this.path(), JSON.stringify(bounded), { mode: 0o644 });
  }

  /** Convenience: check whether a hash is in the delivered set. Read-
   *  only; does not touch state. Caller reads state once + calls this
   *  many times, then persists updates in one `save` call. */
  static isDelivered(state: WatcherStoreState, eventHash: string): boolean {
    return state.delivered.includes(eventHash);
  }

  /** Convenience: return a new state with `eventHash` prepended to
   *  `delivered` (newest-first) + `cursor` updated. Pure — doesn't
   *  mutate `state`. Caps the delivered list at `cap` entries. */
  static markDelivered(state: WatcherStoreState, eventHash: string, newCursor: string, cap: number = DEFAULT_DEDUP_CAP): WatcherStoreState {
    // De-dupe on prepend so a hash re-notified in the same session
    // doesn't take up multiple slots (rare but possible with source
    // adapters that re-emit).
    const filtered = state.delivered.filter((h) => h !== eventHash);
    const next = [eventHash, ...filtered].slice(0, cap);
    return { cursor: newCursor, delivered: next };
  }

  private path(): string {
    return `${this.baseDir}/${this.source}.state.json`;
  }
}

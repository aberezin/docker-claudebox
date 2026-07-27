import { test, expect, describe } from "bun:test";
import { WatcherStore, DEFAULT_DEDUP_CAP, type WatcherStoreState } from "./WatcherStore.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

// Spec: #45 converged dedup + cursor contract (per-source ring-buffer).

const BASE = "/xdg/dridock/watch-cursors";
const path = (source: string): string => `${BASE}/${source}.state.json`;

describe("WatcherStore.load — reads or defaults", () => {
  test("absent file → empty defaults (cursor='', delivered=[])", async () => {
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    expect(await store.load()).toEqual({ cursor: "", delivered: [] });
  });

  test("valid JSON → cursor + delivered restored", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(path("github"), JSON.stringify({ cursor: "2026-07-26T15:00:00Z", delivered: ["h1", "h2"] }));
    const store = new WatcherStore(fs, BASE, "github");
    expect(await store.load()).toEqual({ cursor: "2026-07-26T15:00:00Z", delivered: ["h1", "h2"] });
  });

  test("corrupt JSON → empty defaults (never throws — degrades to re-deliver, not crash)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(path("github"), "{not json");
    const store = new WatcherStore(fs, BASE, "github");
    expect(await store.load()).toEqual({ cursor: "", delivered: [] });
  });

  test("empty file → empty defaults", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(path("github"), "");
    const store = new WatcherStore(fs, BASE, "github");
    expect(await store.load()).toEqual({ cursor: "", delivered: [] });
  });

  test("state with non-string entries in delivered → filtered out (defensive)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(path("github"), JSON.stringify({ cursor: "x", delivered: ["h1", 42, null, "h2"] }));
    const store = new WatcherStore(fs, BASE, "github");
    expect(await store.load()).toEqual({ cursor: "x", delivered: ["h1", "h2"] });
  });

  test("load respects the cap when persisted state exceeds it (past truncation)", async () => {
    const fs = new InMemoryFileSystem();
    const big = Array.from({ length: 1000 }, (_, i) => `h${i}`);
    fs.seed(path("github"), JSON.stringify({ cursor: "x", delivered: big }));
    const store = new WatcherStore(fs, BASE, "github", 100);
    const loaded = await store.load();
    expect(loaded.delivered).toHaveLength(100);
    // Kept newest — .slice(0, cap) with newest-first array
    expect(loaded.delivered[0]).toBe("h0");
    expect(loaded.delivered[99]).toBe("h99");
  });
});

describe("WatcherStore.save — atomic, capped", () => {
  test("save then load roundtrip", async () => {
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    await store.save({ cursor: "cursor-1", delivered: ["h1", "h2", "h3"] });
    expect(await store.load()).toEqual({ cursor: "cursor-1", delivered: ["h1", "h2", "h3"] });
  });

  test("save creates the baseDir if missing (mkdir -p semantics)", async () => {
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    await store.save({ cursor: "", delivered: [] });
    expect(await fs.isDirectory(BASE)).toBe(true);
  });

  test("save caps delivered at ring-buffer boundary", async () => {
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github", 3);
    await store.save({ cursor: "x", delivered: ["h1", "h2", "h3", "h4", "h5"] });
    const loaded = await store.load();
    expect(loaded.delivered).toEqual(["h1", "h2", "h3"]);
  });

  test("save is atomic (writeTextAtomic — power-cut mid-write can't leave a truncated file)", async () => {
    // The InMemoryFileSystem's writeTextAtomic is instantly atomic;
    // this test documents the intent rather than genuinely exercising
    // the atomicity primitive. A real fault-injection test would need
    // a fake that fails partway through a normal writeText.
    const fs = new InMemoryFileSystem();
    const store = new WatcherStore(fs, BASE, "github");
    await store.save({ cursor: "a", delivered: ["h1"] });
    await store.save({ cursor: "b", delivered: ["h2"] });
    expect(await store.load()).toEqual({ cursor: "b", delivered: ["h2"] });
  });

  test("per-source isolation — github state doesn't affect consult state", async () => {
    const fs = new InMemoryFileSystem();
    const gh = new WatcherStore(fs, BASE, "github");
    const cs = new WatcherStore(fs, BASE, "consult");
    await gh.save({ cursor: "gh-cursor", delivered: ["gh-1"] });
    await cs.save({ cursor: "cs-cursor", delivered: ["cs-1"] });
    expect(await gh.load()).toEqual({ cursor: "gh-cursor", delivered: ["gh-1"] });
    expect(await cs.load()).toEqual({ cursor: "cs-cursor", delivered: ["cs-1"] });
  });
});

describe("WatcherStore.isDelivered / .markDelivered — pure helpers", () => {
  test("isDelivered — set membership check", () => {
    const state: WatcherStoreState = { cursor: "x", delivered: ["h1", "h2"] };
    expect(WatcherStore.isDelivered(state, "h1")).toBe(true);
    expect(WatcherStore.isDelivered(state, "h2")).toBe(true);
    expect(WatcherStore.isDelivered(state, "h-unknown")).toBe(false);
  });

  test("markDelivered — prepends newest-first, updates cursor, does NOT mutate input", () => {
    const state: WatcherStoreState = { cursor: "old-cursor", delivered: ["h1", "h2"] };
    const next = WatcherStore.markDelivered(state, "h3", "new-cursor");
    expect(next).toEqual({ cursor: "new-cursor", delivered: ["h3", "h1", "h2"] });
    // Input untouched — pure function.
    expect(state).toEqual({ cursor: "old-cursor", delivered: ["h1", "h2"] });
  });

  test("markDelivered — de-dupes on prepend (same hash re-delivered doesn't take two slots)", () => {
    const state: WatcherStoreState = { cursor: "x", delivered: ["h1", "h2", "h3"] };
    const next = WatcherStore.markDelivered(state, "h2", "y");
    // h2 moves to the front, doesn't appear twice
    expect(next.delivered).toEqual(["h2", "h1", "h3"]);
  });

  test("markDelivered — respects cap (evicts oldest when full)", () => {
    const state: WatcherStoreState = { cursor: "x", delivered: ["h1", "h2", "h3"] };
    const next = WatcherStore.markDelivered(state, "h4", "y", 3);
    // h4 prepended, h3 (oldest) evicted
    expect(next.delivered).toEqual(["h4", "h1", "h2"]);
  });

  test("DEFAULT_DEDUP_CAP is 500 (the value spec'd on #45)", () => {
    expect(DEFAULT_DEDUP_CAP).toBe(500);
  });
});

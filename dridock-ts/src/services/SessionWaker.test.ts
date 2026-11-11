import { test, expect, describe } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInboxSink } from "./InboxSink.ts";
import type { WatcherEvent } from "./WatcherEvent.ts";
import {
  readWakeTarget, raiseCursor, socketPayload, realSocketPoster, wakeFileFor,
  type WakeTarget, type SocketPoster,
} from "./SessionWaker.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

// Spec: #107 — wake the agent's Claude session through its inbox socket.

const REPO = "aberezin/docker-claudebox";
const INBOX = "/xdg/dridock/inbox/Bear.jsonl";
const CURSORS = `${INBOX}.session-cursors.json`;
const WAKE = wakeFileFor(INBOX);
const HEART = "/xdg/dridock/watch-cursors/github.heartbeat";

function stderrCapture(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s) => lines.push(s), lines };
}

function commentEvent(): WatcherEvent {
  return {
    source: "github", kind: "comment", ref: "github:#107#comment-42",
    header: { sender: "Arfy", recipients: ["Bear"], legacy: false },
    summary: "Arfy->Bear: reviewed", eventHash: "abc123",
    cursor: "2026-11-11T00:00:00Z", observedAt: "2026-11-11T00:00:00Z",
  };
}

function recordingPoster(ok: boolean): { poster: SocketPoster; calls: Array<{ target: WakeTarget; text: string }> } {
  const calls: Array<{ target: WakeTarget; text: string }> = [];
  return { calls, poster: async (target, text) => { calls.push({ target, text }); return ok; } };
}

function sink(fs: InMemoryFileSystem, poster: SocketPoster | undefined, stderr = stderrCapture()) {
  return makeInboxSink({ fs, inboxPath: INBOX, selfName: "Bear", repo: REPO, heartbeatPath: HEART, stderr, ...(poster ? { poster } : {}) });
}

describe("readWakeTarget", () => {
  test("absent → undefined (socket delivery off)", async () => {
    expect(await readWakeTarget(new InMemoryFileSystem(), WAKE)).toBeUndefined();
  });
  test("valid → socket, sessionId, token", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/tmp/cc-socks/9.sock", token: "t0k", sessionId: "s1" }));
    expect(await readWakeTarget(fs, WAKE)).toEqual({ socket: "/tmp/cc-socks/9.sock", token: "t0k", sessionId: "s1" });
  });
  test("no token → still valid (accept doesn't need it)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/s.sock", sessionId: "s1" }));
    expect(await readWakeTarget(fs, WAKE)).toEqual({ socket: "/s.sock", sessionId: "s1" });
  });
  test("missing sessionId, or malformed JSON → undefined, never a half target", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/s.sock" }));
    expect(await readWakeTarget(fs, WAKE)).toBeUndefined();
    fs.seed(WAKE, "{not json");
    expect(await readWakeTarget(fs, WAKE)).toBeUndefined();
  });
});

describe("raiseCursor — never lowers, never clobbers what it can't parse", () => {
  test("creates the entry when absent", async () => {
    const fs = new InMemoryFileSystem();
    expect(await raiseCursor(fs, CURSORS, "s1", 100)).toBe(true);
    expect(JSON.parse(await fs.readText(CURSORS))).toEqual({ s1: 100 });
  });
  test("raises an existing lower cursor and keeps other sessions", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CURSORS, JSON.stringify({ old: 5, s1: 50 }));
    await raiseCursor(fs, CURSORS, "s1", 100);
    expect(JSON.parse(await fs.readText(CURSORS))).toEqual({ old: 5, s1: 100 });
  });
  test("never lowers: a higher cursor from the hook survives a late fetcher write", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CURSORS, JSON.stringify({ s1: 200 }));
    expect(await raiseCursor(fs, CURSORS, "s1", 100)).toBe(true);
    expect(JSON.parse(await fs.readText(CURSORS))).toEqual({ s1: 200 });
  });
  test("unparseable file → false and left byte-for-byte alone", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CURSORS, "{corrupt");
    expect(await raiseCursor(fs, CURSORS, "s1", 100)).toBe(false);
    expect(await fs.readText(CURSORS)).toBe("{corrupt");
  });
});

describe("socketPayload — the wire format Claude Code's own hint documents", () => {
  test("auth line first when there is a token, then one user-message line", () => {
    const lines = socketPayload({ socket: "/s", sessionId: "s1", token: "t0k" }, "hi").trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: "auth", token: "t0k" },
      { type: "user", message: { role: "user", content: "hi" } },
    ]);
  });
  test("no auth line without a token", () => {
    const lines = socketPayload({ socket: "/s", sessionId: "s1" }, "hi").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe("user");
  });
});

describe("InboxSink + wake (#107)", () => {
  test("no wake file → event appended, poster never called (Monitor/drain path as before)", async () => {
    const fs = new InMemoryFileSystem();
    const { poster, calls } = recordingPoster(true);
    expect(await sink(fs, poster).onEvent(commentEvent())).toBe(true);
    expect(await fs.readText(INBOX)).toContain("github:#107#comment-42");
    expect(calls).toHaveLength(0);
  });

  test("wake file + successful post → session woken with the event, cursor raised past it", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/s.sock", sessionId: "s1" }));
    const { poster, calls } = recordingPoster(true);
    expect(await sink(fs, poster).onEvent(commentEvent())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target.sessionId).toBe("s1");
    expect(calls[0]!.text).toContain("Arfy → Bear");
    expect(calls[0]!.text).toContain("Arfy->Bear: reviewed");
    // The raw JSONL line rides along, so the agent can parse it as before.
    expect(calls[0]!.text).toContain(`inbox line: ${(await fs.readText(INBOX)).trimEnd()}`);
    const size = await fs.sizeBytes(INBOX);
    expect(JSON.parse(await fs.readText(CURSORS))).toEqual({ s1: size });
  });

  test("wake file + FAILED post → event still appended and delivered to the file, cursor NOT advanced, failure logged", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/gone.sock", sessionId: "s1" }));
    fs.seed(CURSORS, JSON.stringify({ s1: 0 }));
    const { poster } = recordingPoster(false);
    const err = stderrCapture();
    expect(await sink(fs, poster, err).onEvent(commentEvent())).toBe(true);
    expect(await fs.readText(INBOX)).toContain("github:#107#comment-42");
    expect(JSON.parse(await fs.readText(CURSORS))).toEqual({ s1: 0 });
    expect(err.lines.join("")).toContain("socket wake failed");
    expect(err.lines.join("")).toContain("stays in the inbox");
  });

  test("a line that won't parse back is logged, not silently skipped (Arfy #107 nit 4)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/s.sock", sessionId: "s1" }));
    const { poster, calls } = recordingPoster(true);
    const err = stderrCapture();
    // No eventHash → no fingerprint → parseInboxLine rejects the line.
    const ev = { ...commentEvent(), eventHash: undefined } as unknown as WatcherEvent;
    expect(await sink(fs, poster, err).onEvent(ev)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(err.lines.join("")).toContain("doesn't parse back");
    expect(await fs.readText(INBOX)).toContain("github:#107#comment-42");
  });

  test("a poster that throws never fails the event", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(WAKE, JSON.stringify({ socket: "/s.sock", sessionId: "s1" }));
    const err = stderrCapture();
    const ok = await sink(fs, async () => { throw new Error("boom"); }, err).onEvent(commentEvent());
    expect(ok).toBe(true);
    expect(err.lines.join("")).toContain("boom");
  });
});

describe("realSocketPoster — against a real Unix socket", () => {
  test("delivers the auth line then the user message, and reports success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-"));
    const path = join(dir, "s.sock");
    const received: string[] = [];
    const server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => { buf += d.toString(); });
      c.on("end", () => { received.push(buf); c.end(); });
    });
    await new Promise<void>((r) => server.listen(path, r));
    try {
      const ok = await realSocketPoster({ socket: path, sessionId: "s1", token: "t0k" }, "hello from the fetcher");
      expect(ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      const lines = received.join("").trimEnd().split("\n").map((l) => JSON.parse(l));
      expect(lines[0]).toEqual({ type: "auth", token: "t0k" });
      expect(lines[1]).toEqual({ type: "user", message: { role: "user", content: "hello from the fetcher" } });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no listener (session gone) → false, promptly, no throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-"));
    try {
      const t0 = Date.now();
      expect(await realSocketPoster({ socket: join(dir, "absent.sock"), sessionId: "s1" }, "x")).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

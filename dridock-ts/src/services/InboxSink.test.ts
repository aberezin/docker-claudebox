import { test, expect, describe } from "bun:test";
import { makeInboxSink, formatInboxLine, parseInboxLine, githubUrlFromRef } from "./InboxSink.ts";
import type { WatcherEvent } from "./WatcherEvent.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

// Spec: #56 (agent-teams delivery), this project's docs/design/agent-teams.md.

const REPO = "aberezin/docker-claudebox";
const INBOX = "/xdg/dridock/inbox/Bear.jsonl";
const HEART = "/xdg/dridock/watch-cursors/github.heartbeat";

function stderrCapture(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s) => lines.push(s), lines };
}

function commentEvent(overrides: Partial<WatcherEvent> = {}): WatcherEvent {
  return {
    source: "github",
    kind: "comment",
    ref: "github:#46#comment-5111100124",
    header: { sender: "Arfy", recipients: ["Bear"], legacy: false },
    summary: "Design accepted…",
    eventHash: "7f3c1d2e4b5a6c8f",
    cursor: "2026-07-29T00:04:08Z",
    observedAt: "2026-07-29T00:04:08Z",
    ...overrides,
  };
}

describe("formatInboxLine — JSONL record shape", () => {
  test("comment event → all fields present incl. derived url", () => {
    const line = formatInboxLine(commentEvent(), REPO);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      observedAt: "2026-07-29T00:04:08Z",
      source: "github",
      kind: "comment",
      ref: "github:#46#comment-5111100124",
      sender: "Arfy",
      recipients: ["Bear"],
      summary: "Design accepted…",
      fingerprint: "7f3c1d2e4b5a6c8f",
      url: "https://github.com/aberezin/docker-claudebox/issues/46#issuecomment-5111100124",
    });
  });

  test("event with no header → sender=<legacy>, recipients=[]", () => {
    const line = formatInboxLine(commentEvent({ header: null }), REPO);
    const parsed = JSON.parse(line);
    expect(parsed.sender).toBe("<legacy>");
    expect(parsed.recipients).toEqual([]);
  });

  test("broadcast header (no recipients) → recipients=[]", () => {
    const line = formatInboxLine(
      commentEvent({ header: { sender: "Alan", recipients: [], legacy: false } }),
      REPO,
    );
    const parsed = JSON.parse(line);
    expect(parsed.sender).toBe("Alan");
    expect(parsed.recipients).toEqual([]);
  });

  test("multi-recipient header preserved in order", () => {
    const line = formatInboxLine(
      commentEvent({ header: { sender: "Arfy", recipients: ["Bear", "Alan"], legacy: false } }),
      REPO,
    );
    const parsed = JSON.parse(line);
    expect(parsed.recipients).toEqual(["Bear", "Alan"]);
  });

  test("issue-body ref → url has no #issuecomment fragment", () => {
    const line = formatInboxLine(commentEvent({ ref: "github:#56#body" }), REPO);
    const parsed = JSON.parse(line);
    expect(parsed.url).toBe("https://github.com/aberezin/docker-claudebox/issues/56");
  });

  test("non-github ref → no url field", () => {
    const line = formatInboxLine(commentEvent({ source: "consult", ref: "consult:abc123" }), REPO);
    const parsed = JSON.parse(line);
    expect(parsed.url).toBeUndefined();
  });

  test("no trailing newline (caller appends)", () => {
    const line = formatInboxLine(commentEvent(), REPO);
    expect(line.endsWith("\n")).toBe(false);
  });
});

describe("githubUrlFromRef — ref → URL derivation", () => {
  test("issue body", () => {
    expect(githubUrlFromRef("github:#46#body", REPO))
      .toBe("https://github.com/aberezin/docker-claudebox/issues/46");
  });
  test("issue comment", () => {
    expect(githubUrlFromRef("github:#46#comment-123", REPO))
      .toBe("https://github.com/aberezin/docker-claudebox/issues/46#issuecomment-123");
  });
  test("head/state event", () => {
    expect(githubUrlFromRef("github:#46#head", REPO))
      .toBe("https://github.com/aberezin/docker-claudebox/issues/46");
  });
  test("non-github source → undefined", () => {
    expect(githubUrlFromRef("consult:xyz", REPO)).toBeUndefined();
    expect(githubUrlFromRef("bug-report:abc#status", REPO)).toBeUndefined();
  });
  test("malformed github ref → undefined", () => {
    expect(githubUrlFromRef("github:no-hash", REPO)).toBeUndefined();
    expect(githubUrlFromRef("github:#abc#body", REPO)).toBeUndefined();
  });
});

describe("parseInboxLine — round-trip + malformed tolerance", () => {
  test("round-trip: format → parse yields the same record", () => {
    const line = formatInboxLine(commentEvent(), REPO);
    const parsed = parseInboxLine(line);
    expect(parsed).toEqual({
      observedAt: "2026-07-29T00:04:08Z",
      source: "github",
      kind: "comment",
      ref: "github:#46#comment-5111100124",
      sender: "Arfy",
      recipients: ["Bear"],
      summary: "Design accepted…",
      fingerprint: "7f3c1d2e4b5a6c8f",
      url: "https://github.com/aberezin/docker-claudebox/issues/46#issuecomment-5111100124",
    });
  });
  test("blank line → undefined", () => {
    expect(parseInboxLine("")).toBeUndefined();
    expect(parseInboxLine("   ")).toBeUndefined();
    expect(parseInboxLine("\n")).toBeUndefined();
  });
  test("comment line (#-prefixed) → undefined", () => {
    expect(parseInboxLine("# manual note")).toBeUndefined();
  });
  test("malformed JSON → undefined (no throw)", () => {
    expect(parseInboxLine("{not valid json")).toBeUndefined();
  });
  test("valid JSON but missing required fields → undefined", () => {
    expect(parseInboxLine(JSON.stringify({ ref: "x" }))).toBeUndefined();
  });
});

describe("makeInboxSink — sink behaviors", () => {
  test("onEvent appends one JSONL line per call, no interleaving", async () => {
    const fs = new InMemoryFileSystem();
    const stderr = stderrCapture();
    const sink = makeInboxSink({ fs, inboxPath: INBOX, selfName: "Bear", repo: REPO, heartbeatPath: HEART, stderr });
    await sink.onEvent(commentEvent({ eventHash: "hash-1", ref: "github:#46#comment-1" }));
    await sink.onEvent(commentEvent({ eventHash: "hash-2", ref: "github:#46#comment-2" }));
    const contents = await fs.readText(INBOX);
    const lines = contents.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).fingerprint).toBe("hash-1");
    expect(JSON.parse(lines[1]!).fingerprint).toBe("hash-2");
  });

  test("onEvent creates parent dir if inbox path doesn't exist yet", async () => {
    const fs = new InMemoryFileSystem();
    const stderr = stderrCapture();
    const sink = makeInboxSink({ fs, inboxPath: INBOX, selfName: "Bear", repo: REPO, heartbeatPath: HEART, stderr });
    await sink.onEvent(commentEvent());
    expect(await fs.exists("/xdg/dridock/inbox")).toBe(true);
  });

  test("onPollFailed writes warning to stderr", async () => {
    const fs = new InMemoryFileSystem();
    const stderr = stderrCapture();
    const sink = makeInboxSink({ fs, inboxPath: INBOX, selfName: "Bear", repo: REPO, heartbeatPath: HEART, stderr });
    if (sink.onPollFailed !== undefined) await sink.onPollFailed("github", "429 rate limited");
    expect(stderr.lines.join("")).toContain("github poll failed: 429 rate limited");
  });

  test("onTickComplete writes heartbeat with agent + repo + inbox fields", async () => {
    const fs = new InMemoryFileSystem();
    const stderr = stderrCapture();
    const sink = makeInboxSink({ fs, inboxPath: INBOX, selfName: "Bear", repo: REPO, heartbeatPath: HEART, stderr });
    if (sink.onTickComplete !== undefined) {
      await sink.onTickComplete({ source: "github", kind: "polled", seen: 3, surfaced: 1, elapsedMs: 42 });
    }
    const hb = JSON.parse(await fs.readText(HEART));
    expect(hb.self).toBe("Bear");
    expect(hb.repo).toBe(REPO);
    expect(hb.inbox).toBe(INBOX);
    expect(hb.seen).toBe(3);
    expect(hb.surfaced).toBe(1);
  });
});

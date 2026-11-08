import { test, expect, describe } from "bun:test";
import { DEFAULT_DEDUP_CAP } from "./WatcherStore.ts";
import {
  GithubWatchSource,
  MAX_EVENTS_PER_POLL,
  issueNumberFromUrl,
  firstLineTruncated,
  bumpIso1ms,
} from "./GithubWatchSource.ts";
import { StubHostCommandRunner } from "../infra/HostCommandRunner.ts";

const REPO = "aberezin/docker-claudebox";
const NOW = "2026-07-26T15:00:00.000Z";

/** Seed the runner with responses for the two `gh api` commands the
 *  source issues for a given `since`. */
function seed(runner: StubHostCommandRunner, since: string, comments: object[], issues: object[]): void {
  const encodedSince = encodeURIComponent(since);
  const commentsCmd = `gh api "repos/${REPO}/issues/comments?since=${encodedSince}&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]?'`;
  const issuesCmd = `gh api "repos/${REPO}/issues?since=${encodedSince}&state=all&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]? | select(.pull_request == null)'`;
  runner.seedCommand(commentsCmd, 0, comments.map((c) => JSON.stringify(c)).join("\n") + (comments.length > 0 ? "\n" : ""));
  runner.seedCommand(issuesCmd, 0, issues.map((i) => JSON.stringify(i)).join("\n") + (issues.length > 0 ? "\n" : ""));
}

describe("GithubWatchSource.poll — first poll (empty cursor)", () => {
  test("empty cursor → uses `now` as since, returns no events, cursor bumped past now", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [], []);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll("");
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.events).toEqual([]);
    // No events → cursor stays at `since` bumped by 1ms.
    expect(out.newCursor).toBe("2026-07-26T15:00:00.001Z");
  });
});

describe("GithubWatchSource.poll — happy path (comments + issues)", () => {
  test("comment with valid header → event with parsed header, correct ref, sorted by observedAt", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [
      {
        id: 123, body: "Arfy->Bear: verified #42",
        issue_url: "https://api.github.com/repos/aberezin/docker-claudebox/issues/42",
        created_at: "2026-07-26T15:01:00Z", updated_at: "2026-07-26T15:01:00Z",
      },
    ], []);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.events).toHaveLength(1);
    const e = out.events[0]!;
    expect(e.source).toBe("github");
    expect(e.kind).toBe("comment");
    expect(e.ref).toBe("github:#42#comment-123");
    expect(e.header).toEqual({ sender: "Arfy", recipients: ["Bear"], legacy: false });
    expect(e.summary).toBe("Arfy->Bear: verified #42");
    expect(e.observedAt).toBe("2026-07-26T15:01:00Z");
    // Cursor bumped past newest event.
    expect(out.newCursor).toBe("2026-07-26T15:01:00.001Z");
  });

  test("comment with plain body → header null, event still emitted (dedup can still fire on future edits)", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [
      { id: 1, body: "just a plain comment", issue_url: "https://api.github.com/repos/x/y/issues/1", created_at: "2026-07-26T15:00:01Z", updated_at: "2026-07-26T15:00:01Z" },
    ], []);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("poll failed");
    expect(out.events[0]!.header).toBeNull();
    expect(out.events[0]!.summary).toBe("just a plain comment");
  });

  test("legacy header → parsed as legacy=true, still emitted", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [
      { id: 1, body: "→ Bear: legacy form", issue_url: "https://api.github.com/repos/x/y/issues/7", created_at: "2026-07-26T15:00:02Z", updated_at: "2026-07-26T15:00:02Z" },
    ], []);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("poll failed");
    expect(out.events[0]!.header).toEqual({ sender: undefined, recipients: ["Bear"], legacy: true });
  });

  test("new issue body → event ref shape is 'github:#N#body'", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [], [
      { number: 50, body: "Bear->Alan,Arfy: filing this...", created_at: "2026-07-26T15:00:03Z", updated_at: "2026-07-26T15:00:03Z" },
    ]);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("poll failed");
    expect(out.events[0]!.ref).toBe("github:#50#body");
    expect(out.events[0]!.header?.recipients).toEqual(["Alan", "Arfy"]);
  });

  test("comments + issues merged and sorted by observedAt (chronological)", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [
      { id: 1, body: "Bear: b", issue_url: "https://api.github.com/repos/x/y/issues/1",
        created_at: "2026-07-26T15:00:05Z", updated_at: "2026-07-26T15:00:05Z" },
      { id: 2, body: "Bear: c", issue_url: "https://api.github.com/repos/x/y/issues/1",
        created_at: "2026-07-26T15:00:03Z", updated_at: "2026-07-26T15:00:03Z" },
    ], [
      { number: 10, body: "Bear: a", created_at: "2026-07-26T15:00:01Z", updated_at: "2026-07-26T15:00:01Z" },
    ]);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("poll failed");
    expect(out.events.map((e) => e.summary)).toEqual(["Bear: a", "Bear: c", "Bear: b"]);
  });

  test("eventHash differs between two comments on the same issue (edit vs new)", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [
      { id: 1, body: "original", issue_url: "https://api.github.com/repos/x/y/issues/1",
        created_at: "2026-07-26T15:00:01Z", updated_at: "2026-07-26T15:00:01Z" },
      { id: 1, body: "original (edited)", issue_url: "https://api.github.com/repos/x/y/issues/1",
        created_at: "2026-07-26T15:00:01Z", updated_at: "2026-07-26T15:00:05Z" },
    ], []);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("poll failed");
    // Same ref (same comment id), different eventHash (different body).
    expect(out.events[0]!.ref).toBe(out.events[1]!.ref);
    expect(out.events[0]!.eventHash).not.toBe(out.events[1]!.eventHash);
  });
});

describe("GithubWatchSource.poll — soft failures", () => {
  test("gh api rc != 0 → poll-failed with reason (never throws)", async () => {
    const runner = new StubHostCommandRunner();
    // Seed no responses — StubHostCommandRunner returns {rc:127, stdout:""}
    // as the default for unknown commands, matching a missing `gh`.
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    expect(out.kind).toBe("poll-failed");
    if (out.kind !== "poll-failed") return;
    expect(out.reason).toContain("gh api");
    expect(out.reason).toContain("rc=127");
  });

  test("comments succeed but issues fail → poll-failed (short-circuits on first failure)", async () => {
    const runner = new StubHostCommandRunner();
    const commentsCmd = `gh api "repos/${REPO}/issues/comments?since=${encodeURIComponent(NOW)}&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]?'`;
    runner.seedCommand(commentsCmd, 0, "");
    // No seed for issues → rc 127.
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    expect(out.kind).toBe("poll-failed");
  });

  test("malformed JSON line in stdout → skipped (not fatal)", async () => {
    const runner = new StubHostCommandRunner();
    const commentsCmd = `gh api "repos/${REPO}/issues/comments?since=${encodeURIComponent(NOW)}&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]?'`;
    const issuesCmd = `gh api "repos/${REPO}/issues?since=${encodeURIComponent(NOW)}&state=all&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]? | select(.pull_request == null)'`;
    runner.seedCommand(commentsCmd, 0, `{not json\n{"id":1,"body":"ok","issue_url":"https://api.github.com/repos/x/y/issues/1","updated_at":"2026-07-26T15:00:01Z"}\n`);
    runner.seedCommand(issuesCmd, 0, "");
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("expected ok");
    // Malformed line dropped; the good one survived.
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.summary).toBe("ok");
  });

  test("comment with missing issue_url → skipped (can't build a valid ref)", async () => {
    const runner = new StubHostCommandRunner();
    seed(runner, NOW, [
      { id: 1, body: "x", updated_at: "2026-07-26T15:00:01Z" }, // no issue_url
      { id: 2, body: "y", issue_url: "https://api.github.com/repos/x/y/issues/1", updated_at: "2026-07-26T15:00:02Z" },
    ], []);
    const src = new GithubWatchSource(runner, REPO, () => NOW);
    const out = await src.poll(NOW);
    if (out.kind !== "ok") throw new Error("expected ok");
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.summary).toBe("y");
  });
});

describe("issueNumberFromUrl — parse GitHub API issue URL", () => {
  test("well-formed URL → number", () => {
    expect(issueNumberFromUrl("https://api.github.com/repos/aberezin/docker-claudebox/issues/42")).toBe(42);
    expect(issueNumberFromUrl("https://api.github.com/repos/a/b/issues/1")).toBe(1);
  });
  test("malformed → undefined", () => {
    expect(issueNumberFromUrl("https://api.github.com/repos/a/b/issues/abc")).toBeUndefined();
    expect(issueNumberFromUrl("")).toBeUndefined();
    expect(issueNumberFromUrl("nothing/that/matches")).toBeUndefined();
  });
  test("zero and negative are rejected (defensive — real API can't emit them but guards do)", () => {
    expect(issueNumberFromUrl("https://api.github.com/repos/a/b/issues/0")).toBeUndefined();
  });
});

describe("firstLineTruncated — first line, truncated with ellipsis", () => {
  test("short first line → unchanged", () => {
    expect(firstLineTruncated("hi\nrest", 10)).toBe("hi");
  });
  test("long first line → truncated with ellipsis (max chars total)", () => {
    const r = firstLineTruncated("a".repeat(300), 10);
    expect(r).toHaveLength(10);
    expect(r.endsWith("…")).toBe(true);
  });
  test("no newline → whole body considered the first line", () => {
    expect(firstLineTruncated("just one line", 100)).toBe("just one line");
  });
});

describe("bumpIso1ms — advance cursor by 1ms to escape inclusive `since=`", () => {
  test("well-formed iso → +1ms", () => {
    expect(bumpIso1ms("2026-07-26T15:00:00.000Z")).toBe("2026-07-26T15:00:00.001Z");
    expect(bumpIso1ms("2026-07-26T15:00:00.999Z")).toBe("2026-07-26T15:00:01.000Z");
  });
  test("second-precision iso → +1ms (adds millisecond field)", () => {
    expect(bumpIso1ms("2026-07-26T15:00:00Z")).toBe("2026-07-26T15:00:00.001Z");
  });
  test("malformed → returns input unchanged (never crashes)", () => {
    expect(bumpIso1ms("not a date")).toBe("not a date");
  });
});

describe("GithubWatchSource.poll — bounded window (#92)", () => {
  // A refused event rewinds the cursor, so a window is re-polled until it
  // succeeds or the budget runs out. Dedup lives in a 500-entry newest-first
  // ring, so a window LARGER than the cap evicts its own head and re-delivers
  // it on every retry. Bounding the window is what makes the rewind safe.

  /** N comments one second apart, oldest first. */
  function manyComments(n: number, startSec = 1): object[] {
    return Array.from({ length: n }, (_, i) => ({
      id: 1000 + i,
      body: `Bear->Arfy: msg ${i}`,
      issue_url: "https://api.github.com/repos/aberezin/docker-claudebox/issues/42",
      updated_at: `2026-07-26T15:${String(Math.floor((startSec + i) / 60)).padStart(2, "0")}:${String((startSec + i) % 60).padStart(2, "0")}Z`,
    }));
  }

  test("a poll never returns more than MAX_EVENTS_PER_POLL", async () => {
    const runner = new StubHostCommandRunner();
    const since = "2026-07-26T14:00:00.000Z";
    seed(runner, since, manyComments(MAX_EVENTS_PER_POLL + 75), []);
    const out = await new GithubWatchSource(runner, REPO, () => NOW).poll(since);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.events.length).toBe(MAX_EVENTS_PER_POLL);
  });

  // THE test. Truncating is only safe if nothing is skipped — a cursor taken
  // from the latest FETCHED event rather than the last KEPT one would claim
  // the whole window was handled while dropping most of it.
  test("the cursor comes from the last KEPT event, so the tail is not skipped", async () => {
    const runner = new StubHostCommandRunner();
    const since = "2026-07-26T14:00:00.000Z";
    const all = manyComments(MAX_EVENTS_PER_POLL + 10);
    seed(runner, since, all, []);
    const out = await new GithubWatchSource(runner, REPO, () => NOW).poll(since);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;

    const lastKept = out.events[out.events.length - 1]!;
    // Cursor is 1ms past the last KEPT event...
    expect(out.newCursor).toBe(new Date(Date.parse(lastKept.observedAt) + 1).toISOString());
    // ...and therefore strictly BEFORE the events that were truncated, so the
    // next poll re-requests them rather than stepping over them.
    const firstDropped = (all[MAX_EVENTS_PER_POLL] as { updated_at: string }).updated_at;
    expect(out.newCursor < new Date(Date.parse(firstDropped) + 1).toISOString()).toBe(true);
  });

  test("the bound is at or under the dedup cap — the property that makes rewind safe", () => {
    // If this ever inverts, a rewound window can evict its own head and the
    // #92 duplicate storm comes back. Asserted against the real constant
    // rather than a copy of the number.
    expect(MAX_EVENTS_PER_POLL).toBeLessThanOrEqual(DEFAULT_DEDUP_CAP);
  });

  test("an under-bound poll is unaffected — no truncation, cursor from the true latest", async () => {
    const runner = new StubHostCommandRunner();
    const since = "2026-07-26T14:00:00.000Z";
    seed(runner, since, manyComments(3), []);
    const out = await new GithubWatchSource(runner, REPO, () => NOW).poll(since);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.events.length).toBe(3);
  });
});

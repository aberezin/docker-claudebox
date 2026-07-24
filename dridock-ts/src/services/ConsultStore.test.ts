import { test, expect, describe } from "bun:test";
import { ConsultStore, parseKeyValueLines } from "./ConsultStore.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

describe("parseKeyValueLines", () => {
  test("basic KEY=VALUE parsing", () => {
    const m = parseKeyValueLines("status=awaiting-framework\ntitle=hello\n");
    expect(m.get("status")).toBe("awaiting-framework");
    expect(m.get("title")).toBe("hello");
  });

  test("last value wins on duplicated key (matches bash `sed | tail -1`)", () => {
    const m = parseKeyValueLines("status=draft\nstatus=awaiting-approval\n");
    expect(m.get("status")).toBe("awaiting-approval");
  });

  test("tolerates trailing whitespace, CRLF, and blank/comment lines", () => {
    const m = parseKeyValueLines("# a comment\nstatus = draft  \r\n\ntitle=  x  \r\n");
    expect(m.get("status")).toBe("draft");
    expect(m.get("title")).toBe("x");
  });

  test("empty or malformed lines silently skipped (no throw)", () => {
    const m = parseKeyValueLines("no-equals-here\n=only-value\nkey=value\n");
    expect(m.get("key")).toBe("value");
    expect(m.size).toBe(1);
  });
});

describe("ConsultStore.list", () => {
  test("returns [] when consult home doesn't exist (matches 'no consults' bash branch)", async () => {
    const fs = new InMemoryFileSystem();
    const store = new ConsultStore(fs, "/home/alan/.config/dridock/consult");
    expect(await store.list()).toEqual([]);
  });

  test("returns [] when consult home exists but has no thread dirs", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/home/alan/.config/dridock/consult");
    const store = new ConsultStore(fs, "/home/alan/.config/dridock/consult");
    expect(await store.list()).toEqual([]);
  });

  test("parses one thread's meta + counts turns", async () => {
    const fs = new InMemoryFileSystem();
    const root = "/home/alan/.config/dridock/consult";
    fs.seed(`${root}/2026-07-21T18-15/meta`, [
      "status=awaiting-approval",
      "title=A2A protocol adoption",
      "project=abc12345",
      "updated=2026-07-21T18-15-00",
    ].join("\n") + "\n");
    fs.seed(`${root}/2026-07-21T18-15/001-framework.md`, "draft body\n");
    fs.seed(`${root}/2026-07-21T18-15/002-human.md`, "approval turn\n");
    fs.seed(`${root}/2026-07-21T18-15/proposed.diff`, "diff --git a/x b/x\n");

    const store = new ConsultStore(fs, root);
    const threads = await store.list();
    expect(threads).toEqual([{
      id: "2026-07-21T18-15",
      status: "awaiting-approval",
      title: "A2A protocol adoption",
      project: "abc12345",
      updated: "2026-07-21T18-15-00",
      turnCount: 2,   // .diff and non-numbered files excluded
    }]);
  });

  test("threads returned sorted by id", async () => {
    const fs = new InMemoryFileSystem();
    const root = "/home/alan/.config/dridock/consult";
    for (const id of ["2026-07-21T18-15", "2026-07-20T09-30", "2026-07-22T00-00"]) {
      fs.seed(`${root}/${id}/meta`, "status=resolved\n");
    }
    const threads = await (new ConsultStore(fs, root)).list();
    expect(threads.map((t) => t.id)).toEqual([
      "2026-07-20T09-30", "2026-07-21T18-15", "2026-07-22T00-00",
    ]);
  });

  test("missing meta file → thread with empty string fields (matches bash's 'status' being blank)", async () => {
    const fs = new InMemoryFileSystem();
    const root = "/home/alan/.config/dridock/consult";
    // Thread dir exists but no meta file
    fs.seedDir(`${root}/orphan-thread`);
    const threads = await (new ConsultStore(fs, root)).list();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      id: "orphan-thread", status: "", title: "", project: "", updated: "", turnCount: 0,
    });
  });
});

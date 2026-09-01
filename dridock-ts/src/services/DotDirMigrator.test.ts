import { test, expect, describe } from "bun:test";
import { DotDirMigrator } from "./DotDirMigrator.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

const ROOT = "/x/projects/abc";

describe("DotDirMigrator", () => {
  test("legacy only → moves, and the content is readable at the new path", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${ROOT}/claude/history.jsonl`, "session\n");
    fs.seed(`${ROOT}/claude/.credentials.json`, "{}");
    const r = await new DotDirMigrator(fs).migrate(ROOT);
    expect(r.kind).toBe("migrated");
    // The point of the whole exercise: the data survives the move.
    expect(await fs.readText(`${ROOT}/dot/.claude/history.jsonl`)).toBe("session\n");
    expect(await fs.readText(`${ROOT}/dot/.claude/.credentials.json`)).toBe("{}");
    expect(await fs.exists(`${ROOT}/claude`)).toBe(false);
  });

  test("already migrated → not-needed, silent (runs on every launch)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${ROOT}/dot/.claude/history.jsonl`, "session\n");
    const r = await new DotDirMigrator(fs).migrate(ROOT);
    expect(r.kind).toBe("not-needed");
    expect(await fs.readText(`${ROOT}/dot/.claude/history.jsonl`)).toBe("session\n");
  });

  test("fresh project, neither exists → not-needed", async () => {
    const r = await new DotDirMigrator(new InMemoryFileSystem()).migrate(ROOT);
    expect(r.kind).toBe("not-needed");
  });

  test("BOTH exist → refuses, and touches NEITHER", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${ROOT}/claude/history.jsonl`, "old-session\n");
    fs.seed(`${ROOT}/dot/.claude/history.jsonl`, "new-session\n");
    const r = await new DotDirMigrator(fs).migrate(ROOT);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("refusing to merge");
    // Merging or picking a winner could overwrite a live session with a stale
    // one. Both must survive untouched so the human can choose.
    expect(await fs.readText(`${ROOT}/claude/history.jsonl`)).toBe("old-session\n");
    expect(await fs.readText(`${ROOT}/dot/.claude/history.jsonl`)).toBe("new-session\n");
  });

  test("legacy path is a FILE, not a directory → refuses rather than clobbering", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${ROOT}/claude`, "not a directory");
    const r = await new DotDirMigrator(fs).migrate(ROOT);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("not a directory");
  });

  test("a move that throws is reported, not swallowed", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${ROOT}/claude/history.jsonl`, "session\n");
    const boom = Object.create(fs) as InMemoryFileSystem;
    boom.move = async () => { throw new Error("EXDEV: cross-device link"); };
    const r = await new DotDirMigrator(boom).migrate(ROOT);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("EXDEV");
    // Source intact — a failed migration must not lose the original.
    expect(await fs.readText(`${ROOT}/claude/history.jsonl`)).toBe("session\n");
  });
});

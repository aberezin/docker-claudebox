import { test, expect, describe } from "bun:test";
import { checkWorkspaceMove, sessionSlug } from "./WorkspaceMoveReporter.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

const STATE = "/x/projects/abc";
const DATA = "/x/projects/abc/dot/.claude";
const opts = (root: string) => ({ stateRoot: STATE, dataDir: DATA, root, binName: "dridock" });

describe("sessionSlug", () => {
  test("every non-alphanumeric character becomes -", () => {
    expect(sessionSlug("/Users/a/docker-claudebox-in-claudebox")).toBe("-Users-a-docker-claudebox-in-claudebox");
    expect(sessionSlug("/u/my.app_v1")).toBe("-u-my-app-v1");
  });
});

describe("checkWorkspaceMove (#123)", () => {
  test("first run: records the path, ok", async () => {
    const fs = new InMemoryFileSystem();
    expect(await checkWorkspaceMove(fs, opts("/u/a"))).toEqual({ kind: "ok" });
    expect((await fs.readText(`${STATE}/last-workspace`)).trim()).toBe("/u/a");
  });

  test("same path: ok", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/a\n");
    expect(await checkWorkspaceMove(fs, opts("/u/a"))).toEqual({ kind: "ok" });
  });

  test("moved, old history present, new absent → moved, with the exact mv; said once", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/projects/-u-old/s1.jsonl`, "{}");
    fs.seed(`${DATA}/projects/-u-old/s2.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new"));
    expect(r.kind).toBe("moved");
    if (r.kind === "moved") {
      expect(r.message).toContain("/u/old → /u/new");
      expect(r.message).toContain("(2 entries)");
      expect(r.message).toContain(`mv '${DATA}/projects/-u-old' '${DATA}/projects/-u-new'`);
    }
    // The new path is recorded first, so the next start proceeds.
    expect(await checkWorkspaceMove(fs, opts("/u/new"))).toEqual({ kind: "ok" });
  });

  test("moved but the new path already has history (user moved it, or chose fresh) → ok", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/projects/-u-old/s1.jsonl`, "{}");
    fs.seed(`${DATA}/projects/-u-new/s9.jsonl`, "{}");
    expect(await checkWorkspaceMove(fs, opts("/u/new"))).toEqual({ kind: "ok" });
  });

  test("moved with no old history → nothing to lose, ok", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    expect(await checkWorkspaceMove(fs, opts("/u/new"))).toEqual({ kind: "ok" });
  });
});

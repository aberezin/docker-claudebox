import { test, expect, describe } from "bun:test";
import { checkWorkspaceMove, sessionSlug, cronHistorySlug } from "./WorkspaceMoveReporter.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

const STATE = "/x/projects/abc";
const DATA = "/x/projects/abc/dot/.claude";
const opts = (root: string, caller: "start" | "cron" = "start") =>
  ({ stateRoot: STATE, dataDir: DATA, root, binName: "dridock", caller });

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
      expect(r.message).toContain(`mkdir -p '${DATA}/projects/-u-new' && mv '${DATA}/projects/-u-old'/* '${DATA}/projects/-u-new'/`);
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

describe("cronHistorySlug (#133)", () => {
  // Fixtures produced by RUNNING cron.py's own slugify() against these inputs,
  // not by reading it: `re.sub(r"[^A-Za-z0-9]+", "_", path).strip("_") or "workspace"`.
  // tests/test_cron_slug_mirror.sh fails if that line in cron.py changes.
  test.each([
    ["/Users/alan/Development/foo-claudebox", "Users_alan_Development_foo_claudebox"],
    ["/Users/alan/Development/foo-dridock", "Users_alan_Development_foo_dridock"],
    ["/workspace", "workspace"],
    ["/a//b", "a_b"],                       // a RUN of separators collapses to one _
    ["/Users/alan/my.proj-2", "Users_alan_my_proj_2"],
    ["/tmp/x_y", "tmp_x_y"],
    ["/-/", "workspace"],                   // nothing alphanumeric → cron.py's fallback
    ["", "workspace"],
  ])("cron.py's rule, not Claude's: %s", (input, want) => {
    expect(cronHistorySlug(input)).toBe(want);
  });

  test("differs from sessionSlug — using one for the other finds nothing", () => {
    const p = "/u/a-b";
    expect(cronHistorySlug(p)).toBe("u_a_b");
    expect(sessionSlug(p)).toBe("-u-a-b");
  });
});

describe("checkWorkspaceMove: cron history (#133)", () => {
  test("cron history orphaned, no session history → reported, with cron's own slug", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/cron/history/u_old/2026-11-17T09-00-00-nightly/activity.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new"));
    expect(r.kind).toBe("moved");
    if (r.kind === "moved") {
      expect(r.dirs.map((d) => d.what)).toEqual(["cron-history"]);
      expect(r.message).toContain("only memory of its last run");
      expect(r.message).toContain(`mv '${DATA}/cron/history/u_old'/* '${DATA}/cron/history/u_new'/`);
      // Not the session wording: there is no session history here.
      expect(r.message).not.toContain("the claudebot would start with none");
    }
  });

  test("both orphaned → ONE message, both mv lines, in order", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/projects/-u-old/s1.jsonl`, "{}");
    fs.seed(`${DATA}/cron/history/u_old/run1/activity.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new"));
    expect(r.kind).toBe("moved");
    if (r.kind === "moved") {
      expect(r.dirs.map((d) => d.what)).toEqual(["sessions", "cron-history"]);
      expect(r.message).toContain(`mv '${DATA}/projects/-u-old'/*`);
      expect(r.message).toContain(`mv '${DATA}/cron/history/u_old'/*`);
      expect(r.message.match(/this project moved/g)?.length).toBe(1);
    }
  });

  test("cron history already at the new slug → not reported, so the printed mv can never clobber", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/cron/history/u_old/run1/activity.jsonl`, "{}");
    fs.seed(`${DATA}/cron/history/u_new/run9/activity.jsonl`, "{}");
    expect(await checkWorkspaceMove(fs, opts("/u/new"))).toEqual({ kind: "ok" });
  });

  test("one record drives both: the session dir is still reported after cron's is moved", async () => {
    // The trap this avoids: a SECOND record per check would let whichever path
    // ran first consume its own and leave the other silent.
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/projects/-u-old/s1.jsonl`, "{}");
    fs.seed(`${DATA}/cron/history/u_old/run1/activity.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new"));
    expect(r.kind === "moved" && r.dirs.length).toBe(2);
  });
});

describe("checkWorkspaceMove: the printed command survives the gap between check and act (#133, Bear review)", () => {
  // `mv OLD NEW` is a rename only while NEW does not exist. Once it does, mv
  // puts OLD *inside* NEW as NEW/old-slug, with rc 0 and no complaint — and
  // nothing looks there. On the cron path cron has already launched, so the
  // first job to fire creates NEW; on start, the user may have started again.
  test("entries form, not a directory rename, with mkdir -p so it works either way", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/cron/history/u_old/run1/activity.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new", "cron"));
    expect(r.kind).toBe("moved");
    if (r.kind === "moved") {
      expect(r.message).toContain(`mkdir -p '${DATA}/cron/history/u_new' && mv '${DATA}/cron/history/u_old'/* '${DATA}/cron/history/u_new'/`);
      // The form that nests once the destination exists must be gone.
      expect(r.message).not.toContain(`mv '${DATA}/cron/history/u_old' '${DATA}/cron/history/u_new'`);
    }
  });

  test("cron wording: a warning, stop-cron-first, and no 'run start again'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/cron/history/u_old/run1/activity.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new", "cron"));
    if (r.kind !== "moved") throw new Error("expected moved");
    expect(r.message.startsWith("⚠️")).toBe(true);        // rc 0 on this path
    expect(r.message).toContain("cron has STARTED");
    expect(r.message).toContain("DRIDOCK_MODE_CRON=1 dridock stop");
    expect(r.message).not.toContain("just run 'dridock start' again");
    expect(r.message).toContain("this is only said once");
  });

  test("start wording keeps the ❌ and its own remedy", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(`${STATE}/last-workspace`, "/u/old\n");
    fs.seed(`${DATA}/projects/-u-old/s1.jsonl`, "{}");
    const r = await checkWorkspaceMove(fs, opts("/u/new", "start"));
    if (r.kind !== "moved") throw new Error("expected moved");
    expect(r.message.startsWith("❌")).toBe(true);
    expect(r.message).toContain("just run 'dridock start' again");
    expect(r.message).not.toContain("cron has STARTED");
  });
});

import { test, expect, describe } from "bun:test";
import { ConsultCommand } from "./ConsultCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { FrozenClock } from "../../infra/Clock.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

const CONSULT_HOME = "/home/alan/.config/dridock/consult";

function seedThread(fs: InMemoryFileSystem, id: string, meta: Record<string, string>): void {
  const lines = Object.entries(meta).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.seed(`${CONSULT_HOME}/${id}/meta`, lines);
}

describe("ConsultCommand.show", () => {
  test("no id → rc 1 usage", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new ConsultCommand().run(["show"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage: dridock consult show");
  });

  test("thread not found → rc 1", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new ConsultCommand().run(["show", "nonexistent"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no such consult");
  });

  test("thread exists → prints meta + numbered turns + proposed.diff", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-approval", title: "the ask", project: "abc" });
    fs.seed(`${CONSULT_HOME}/t1/001-framework.md`, "draft body\n");
    fs.seed(`${CONSULT_HOME}/t1/002-human.md`, "response\n");
    fs.seed(`${CONSULT_HOME}/t1/proposed.diff`, "diff --git a/x b/x\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new ConsultCommand().run(["show", "t1"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("=== consult t1 ===");
    expect(out).toContain("status=awaiting-approval");
    expect(out).toContain("── 001-framework.md ──");
    expect(out).toContain("draft body");
    expect(out).toContain("── 002-human.md ──");
    expect(out).toContain("── proposed.diff ──");
    expect(out).toContain("diff --git");
  });
});

describe("ConsultCommand.approve", () => {
  test("thread with status awaiting-approval → status → awaiting-claudebot + human turn appended", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-approval", title: "x" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new ConsultCommand(new FrozenClock("20260722-000000")).run(["approve", "t1"], ctx);
    expect(rc).toBe(0);
    const meta = await fs.readText(`${CONSULT_HOME}/t1/meta`);
    expect(meta).toContain("status=awaiting-claudebot");
    expect(meta).toContain("updated=20260722-000000");
    // A NEW turn file exists
    const turnPath = `${CONSULT_HOME}/t1/001-human.md`;
    expect(await fs.exists(turnPath)).toBe(true);
    expect(await fs.readText(turnPath)).toContain("Approved by the human");
    expect(stdout.text()).toContain("✅ approved t1");
  });

  test("thread with wrong status → note on stderr but proceeds", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "resolved" });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new ConsultCommand().run(["approve", "t1"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("expected awaiting-approval");
  });

  test("missing thread → rc 1 with 'no such consult'", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new ConsultCommand().run(["approve", "nonexistent"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no such consult");
  });
});

describe("ConsultCommand.revise", () => {
  test("no note → 'please revise the draft' default", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-approval" });
    const { ctx, stdout } = makeCtx(fs);
    await new ConsultCommand().run(["revise", "t1"], ctx);
    const meta = await fs.readText(`${CONSULT_HOME}/t1/meta`);
    expect(meta).toContain("status=awaiting-framework");
    expect(await fs.readText(`${CONSULT_HOME}/t1/001-human.md`)).toContain("please revise the draft");
    expect(stdout.text()).toContain("↩️  bounced t1");
  });

  test("with note → note is the turn body", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-approval" });
    const { ctx } = makeCtx(fs);
    await new ConsultCommand().run(["revise", "t1", "narrower", "scope"], ctx);
    expect(await fs.readText(`${CONSULT_HOME}/t1/001-human.md`)).toContain("narrower scope");
  });
});

describe("ConsultCommand.reject", () => {
  test("with reason → status → rejected + reason posted", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-approval" });
    const { ctx, stdout } = makeCtx(fs);
    await new ConsultCommand().run(["reject", "t1", "out", "of", "scope"], ctx);
    expect(await fs.readText(`${CONSULT_HOME}/t1/meta`)).toContain("status=rejected");
    expect(await fs.readText(`${CONSULT_HOME}/t1/001-human.md`)).toContain("out of scope");
    expect(stdout.text()).toContain("🚫 rejected t1");
  });
});

describe("ConsultCommand.post", () => {
  test("--author + body from stdin → next NNN-<author>.md written", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-framework" });
    const cmd = new ConsultCommand(undefined, undefined, 0, async () => "draft turn body\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run(["post", "t1", "--author", "framework"], ctx);
    expect(rc).toBe(0);
    expect(await fs.readText(`${CONSULT_HOME}/t1/001-framework.md`)).toBe("draft turn body\n");
    expect(stdout.text()).toContain("posted framework turn to t1");
  });

  test("--status also updates meta", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-framework" });
    const cmd = new ConsultCommand(undefined, undefined, 0, async () => "body\n");
    const { ctx } = makeCtx(fs);
    await cmd.run(["post", "t1", "--author", "framework", "--status", "awaiting-approval"], ctx);
    expect(await fs.readText(`${CONSULT_HOME}/t1/meta`)).toContain("status=awaiting-approval");
  });

  test("--diff with existing file → copies to proposed.diff", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-framework" });
    fs.seed("/tmp/my.diff", "diff --git a/x b/x\n");
    const cmd = new ConsultCommand(undefined, undefined, 0, async () => "body\n");
    const { ctx } = makeCtx(fs);
    await cmd.run(["post", "t1", "--diff", "/tmp/my.diff"], ctx);
    expect(await fs.readText(`${CONSULT_HOME}/t1/proposed.diff`)).toBe("diff --git a/x b/x\n");
  });

  test("unknown flag → DridockError (#37 T1 #6: no silent swallow)", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-framework" });
    const cmd = new ConsultCommand(undefined, undefined, 0, async () => "body\n");
    const { ctx } = makeCtx(fs);
    try {
      await cmd.run(["post", "t1", "--auther", "framework"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as Error).message).toContain("--auther");
    }
  });

  test("--diff with missing file → error rc (#37 T1 #6)", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "awaiting-framework" });
    const cmd = new ConsultCommand(undefined, undefined, 0, async () => "body\n");
    const { ctx } = makeCtx(fs);
    // The store.attachDiff throws; unhandled error propagates. That's fine —
    // for consistency with bash which `exit 1`s. Cover with try/catch.
    try {
      await cmd.run(["post", "t1", "--diff", "/nonexistent"], ctx);
      throw new Error("expected error");
    } catch (e) {
      expect((e as Error).message).toContain("source not found");
    }
  });
});

describe("ConsultCommand.watch", () => {
  test("no new awaiting-framework threads across polls → keeps looping (bounded by maxWatchIterations)", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "resolved" }); // NOT awaiting-framework
    const sleeps: number[] = [];
    const cmd = new ConsultCommand(undefined, async (ms) => { sleeps.push(ms); }, 3);
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run(["watch", "1"], ctx);
    expect(rc).toBe(0);   // hit maxWatchIterations
    expect(sleeps.length).toBe(3);
    expect(sleeps[0]).toBe(1000);   // 1 second poll
  });

  test("thread newly enters awaiting-framework → prints it + rc 0", async () => {
    const fs = new InMemoryFileSystem();
    seedThread(fs, "t1", { status: "resolved" });
    let pollCount = 0;
    const cmd = new ConsultCommand(undefined, async () => {
      pollCount++;
      if (pollCount === 1) {
        // Between poll 1 and 2: a new awaiting-framework thread arrives
        seedThread(fs, "t-new", { status: "awaiting-framework" });
      }
    }, 5);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run(["watch", "1"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("awaiting a framework draft");
    expect(stdout.text()).toContain("t-new");
  });
});

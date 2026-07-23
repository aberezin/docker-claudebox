import { test, expect, describe } from "bun:test";
import { DownCommand } from "./DownCommand.ts";
import { DestroyCommand } from "./DestroyCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): {
  ctx: Context; stdout: StringWriter; stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

describe("DownCommand", () => {
  test("no config.yml → prints 'no dridock VM' and rc 0", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DownCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("no dridock VM");
    expect(colima.stops).toEqual([]);
  });

  test("with config.yml → calls colima.stop(cb-<id>) + prints ✓", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DownCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(colima.stops).toEqual(["cb-abc"]);
    expect(stdout.text()).toContain("stopped");
  });
});

describe("DestroyCommand", () => {
  test("no config.yml → prints 'no dridock project' and rc 0", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DestroyCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("no dridock project");
    expect(colima.deletions).toEqual([]);
  });

  test("with config.yml → colima.delete + rc 0", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DestroyCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(colima.deletions).toEqual(["cb-abc"]);
    expect(stdout.text()).toContain("destroyed");
  });

  test("--purge → VM destroyed AND data dir rm -rf'd (P4c: fully ported)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    // Seed the data dir with content — proves rm -rf actually removes it
    fs.seed("/home/alan/.config/dridock/projects/abc/claude/session.json", "{}");
    fs.seed("/home/alan/.config/dridock/projects/abc/claude/.features", "typescript\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DestroyCommand(colima, new StubGitToplevel("/p")).run(["--purge"], ctx);
    expect(rc).toBe(0);
    expect(colima.deletions).toEqual(["cb-abc"]);
    expect(stdout.text()).toContain("purging data dir /home/alan/.config/dridock/projects/abc/claude");
    // Data dir content actually gone
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/claude/session.json")).toBe(false);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/claude/.features")).toBe(false);
  });

  test("--purge idempotent when data dir doesn't exist (rm -rf semantics)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    // NO data dir seeded
    const colima = new InMemoryColima();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DestroyCommand(colima, new StubGitToplevel("/p")).run(["--purge"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("purged");
  });

  test("unknown arg → DridockError rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    try {
      await new DestroyCommand(new InMemoryColima(), new StubGitToplevel("/p")).run(["--nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as DridockError).exitCode).toBe(1);
    }
  });

  test("--help prints usage + rc 0", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DestroyCommand(new InMemoryColima(), new StubGitToplevel("/p")).run(["--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock destroy");
  });
});

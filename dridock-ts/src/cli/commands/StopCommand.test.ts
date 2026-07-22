import { test, expect, describe } from "bun:test";
import { StopCommand } from "./StopCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter } {
  const stdout = new StringWriter();
  return {
    stdout,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr: new StringWriter() },
  };
}

describe("StopCommand", () => {
  test("no config.yml → 'no dridock project here', rc 0", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new StopCommand(new InMemoryColima(), new InMemoryContainerRuntime(), new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("nothing to stop");
  });

  test("VM stopped → 'nothing running (VM ... not up)'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Stopped", address: "" });
    const runtime = new InMemoryContainerRuntime();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new StopCommand(colima, runtime, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("nothing running (VM cb-abc not up)");
    expect(runtime.stops).toEqual([]);
  });

  test("VM running but no container → 'nothing running (no container ...)'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new StopCommand(colima, new InMemoryContainerRuntime(), new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("no container claude-_p");
  });

  test("VM running + container exists → stops it + prints 'stopped'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const runtime = new InMemoryContainerRuntime();
    runtime.seedPs("claude-_p", { name: "claude-_p", status: "Up 5m", image: "dridock:latest" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new StopCommand(colima, runtime, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("stopped claude-_p");
    expect(runtime.stops).toEqual([{ context: "colima-cb-abc", container: "claude-_p" }]);
  });
});

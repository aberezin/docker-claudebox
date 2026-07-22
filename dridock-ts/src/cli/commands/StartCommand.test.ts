import { test, expect, describe } from "bun:test";
import { StartCommand } from "./StartCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
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

function seedReadyProject(fs: InMemoryFileSystem, colima: InMemoryColima, docker: InMemoryDocker, id = "abc"): void {
  fs.seed("/p/.dridock/config.yml", `id: ${id}\n`);
  colima.seedVm({ name: `cb-${id}`, status: "Running", address: "1.2.3.4" });
  docker.seedImage(`colima-cb-${id}`, "dridock:latest", "3.3.7");
}

describe("StartCommand — guards", () => {
  test("cwd inside .dridock/ → guard rejects with rc 1 + advice", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs, "/proj/.dridock");
    const rc = await new StartCommand("dridock:latest", new InMemoryColima(), new InMemoryContainerRuntime(), new InMemoryDocker(), new StubGitToplevel("/proj")).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("inside a '.dridock'");
    expect(stderr.text()).toContain("cd /proj");
    expect(stderr.text()).toContain("DRIDOCK_ALLOW_SUBDIR");
  });

  test("no config.yml → rc 1 + hint to bootstrap", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", new InMemoryColima(), new InMemoryContainerRuntime(), new InMemoryDocker(), new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no dridock project here");
  });

  test("VM stopped → rc 2 + Phase 4b hint (visible skip per audit rule)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Stopped", address: "" });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", colima, new InMemoryContainerRuntime(), new InMemoryDocker(), new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(2);
    expect(stderr.text()).toContain("not running");
    expect(stderr.text()).toContain("Phase 4");
  });

  test("image not present → rc 2 + advice", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker(); // nothing seeded → IMAGE_UNAVAILABLE
    seedReadyProject(fs, colima, docker);
    // Now REMOVE the image seed to simulate absent image
    const docker2 = new InMemoryDocker();
    // (Colima+config remain seeded; image is not.)
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", colima, new InMemoryContainerRuntime(), docker2, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(2);
    expect(stderr.text()).toContain("not present");
  });
});

describe("StartCommand — interactive path (assumes VM up + image present)", () => {
  test("no existing container → runInteractive with correct mounts + cmd", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    const runtime = new InMemoryContainerRuntime();
    seedReadyProject(fs, colima, docker);
    const { ctx } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", colima, runtime, docker, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(runtime.runs.length).toBe(1);
    const run = runtime.runs[0]!;
    expect(run.containerName).toBe("claude-_p");
    expect(run.mode).toBe("interactive");
    expect(run.workdir).toBe("/p");
    expect(run.network).toBe("cb-net");
    // Essential mounts present
    expect(run.mounts).toContainEqual({ host: "/p", container: "/p" });
    expect(run.mounts).toContainEqual({ host: "/home/alan/.claude", container: "/home/claude/.claude" });
    expect(run.mounts).toContainEqual({ host: "/var/run/docker.sock", container: "/var/run/docker.sock" });
    // Command form
    expect(run.cmd[0]).toBe("claude");
    expect(run.cmd).toContain("--dangerously-skip-permissions");
  });

  test("existing container → startAttached, not runInteractive", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    const runtime = new InMemoryContainerRuntime();
    seedReadyProject(fs, colima, docker);
    runtime.seedPs("claude-_p", { name: "claude-_p", status: "Exited (0) 5m", image: "dridock:latest" });
    const { ctx } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", colima, runtime, docker, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(runtime.starts).toEqual([{ context: "colima-cb-abc", container: "claude-_p" }]);
    expect(runtime.runs).toEqual([]);
  });

  test("passes extra args through to claude cmd", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    const runtime = new InMemoryContainerRuntime();
    seedReadyProject(fs, colima, docker);
    const { ctx } = makeCtx(fs);
    await new StartCommand("dridock:latest", colima, runtime, docker, new StubGitToplevel("/p")).run(["--resume"], ctx);
    expect(runtime.runs[0]!.cmd).toContain("--resume");
  });
});

describe("StartCommand — programmatic (-p) path", () => {
  test("valid -p → runs the _prog container with validated args", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    const runtime = new InMemoryContainerRuntime();
    seedReadyProject(fs, colima, docker);
    const { ctx } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", colima, runtime, docker, new StubGitToplevel("/p")).run(["-p", "hello world"], ctx);
    expect(rc).toBe(0);
    expect(runtime.runs.length).toBe(1);
    const run = runtime.runs[0]!;
    expect(run.containerName).toBe("claude-_p_prog");
    expect(run.cmd).toContain("-p");
    expect(run.cmd).toContain("hello world");
    expect(run.cmd).toContain("--output-format");
    expect(run.cmd).toContain("text");   // default format added by validator
    // Env: DRIDOCK_CONTAINER_NAME wired for sidecar IPC
    expect(run.env).toContainEqual({ key: "DRIDOCK_CONTAINER_NAME", value: "claude-_p_prog" });
  });

  test("invalid flag → DridockError with 'Unknown flag' (not a silent pass-through)", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    seedReadyProject(fs, colima, docker);
    const { ctx } = makeCtx(fs);
    try {
      await new StartCommand("dridock:latest", colima, new InMemoryContainerRuntime(), docker, new StubGitToplevel("/p")).run(["-p", "hi", "--nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as Error).message).toContain("Unknown flag");
    }
  });

  test("invalid --effort → DridockError (matches #31 fix)", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    seedReadyProject(fs, colima, docker);
    const { ctx } = makeCtx(fs);
    try {
      await new StartCommand("dridock:latest", colima, new InMemoryContainerRuntime(), docker, new StubGitToplevel("/p")).run(["-p", "hi", "--effort", "hihg"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as Error).message).toContain("Invalid effort");
    }
  });

  test("--update deferred to Phase 4b (visible stub, rc 2)", async () => {
    const fs = new InMemoryFileSystem();
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    seedReadyProject(fs, colima, docker);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new StartCommand("dridock:latest", colima, new InMemoryContainerRuntime(), docker, new StubGitToplevel("/p")).run(["-p", "hi", "--update"], ctx);
    expect(rc).toBe(2);
    expect(stderr.text()).toContain("--update is Phase 4b");
  });
});

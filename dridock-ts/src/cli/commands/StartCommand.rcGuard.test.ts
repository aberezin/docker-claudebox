import { test, expect, describe } from "bun:test";
import { hasRemoteControlFlag, warnIfRemoteControlBelowFloor, StartCommand } from "./StartCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StubHostGit } from "../../test/fakes/StubHostGit.ts";
import { StubProcessProbe } from "../../infra/ProcessProbe.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { infraContext, projectContext, IMAGE_UNAVAILABLE, IMAGE_UNSTAMPED } from "../../infra/Docker.ts";

describe("hasRemoteControlFlag — argv detection", () => {
  test("--remote-control (bare) → true", () => {
    expect(hasRemoteControlFlag(["--remote-control"])).toBe(true);
  });
  test("--rc (short form) → true", () => {
    expect(hasRemoteControlFlag(["--rc"])).toBe(true);
  });
  test("--remote-control=foo → true", () => {
    expect(hasRemoteControlFlag(["--remote-control=foo"])).toBe(true);
  });
  test("--rc=foo → true", () => {
    expect(hasRemoteControlFlag(["--rc=foo"])).toBe(true);
  });
  test("--remote-control-session-name-prefix (decoy) → false (must be EXACT match)", () => {
    // Old CLIs carry this option — bash pads with spaces at wrapper.sh:3351
    // to avoid false-firing. TS uses `===` for the same effect.
    expect(hasRemoteControlFlag(["--remote-control-session-name-prefix"])).toBe(false);
    expect(hasRemoteControlFlag(["--remote-control-session-name-prefix=x"])).toBe(false);
  });
  test("--rcx (typo) → false — startsWith would false-positive, exact match doesn't", () => {
    expect(hasRemoteControlFlag(["--rcx"])).toBe(false);
  });
  test("no RC flag → false", () => {
    expect(hasRemoteControlFlag(["--model", "opus"])).toBe(false);
    expect(hasRemoteControlFlag([])).toBe(false);
  });
});

describe("warnIfRemoteControlBelowFloor — the #17 guard body", () => {
  const CTX = projectContext("abc");
  const IMG = "dridock:latest";

  test("cliVersion below floor → warning to stderr (multi-line)", async () => {
    const docker = new InMemoryDocker();
    docker.seedClaudeCliVersion(CTX, IMG, "2.1.100");
    const stderr = new StringWriter();
    await warnIfRemoteControlBelowFloor(docker, CTX, IMG, stderr);
    const text = stderr.text();
    expect(text).toContain("--remote-control: this project's image ships Claude Code 2.1.100");
    expect(text).toContain("needs >= 2.1.206");
    expect(text).toContain("IGNORES unknown flags");
    expect(text).toContain("make build");
    expect(text).toContain("Continuing anyway");
  });

  test("cliVersion equal to floor → no warning", async () => {
    const docker = new InMemoryDocker();
    docker.seedClaudeCliVersion(CTX, IMG, "2.1.206");
    const stderr = new StringWriter();
    await warnIfRemoteControlBelowFloor(docker, CTX, IMG, stderr);
    expect(stderr.text()).toBe("");
  });

  test("cliVersion above floor → no warning", async () => {
    const docker = new InMemoryDocker();
    docker.seedClaudeCliVersion(CTX, IMG, "2.5.0");
    const stderr = new StringWriter();
    await warnIfRemoteControlBelowFloor(docker, CTX, IMG, stderr);
    expect(stderr.text()).toBe("");
  });

  test("cliVersion IMAGE_UNAVAILABLE → silent (docker call failed or image absent — VmEnsure handles those)", async () => {
    const docker = new InMemoryDocker();
    docker.seedClaudeCliVersion(CTX, IMG, IMAGE_UNAVAILABLE);
    const stderr = new StringWriter();
    await warnIfRemoteControlBelowFloor(docker, CTX, IMG, stderr);
    expect(stderr.text()).toBe("");
  });

  test("cliVersion IMAGE_UNSTAMPED → silent (very-old image predates the label)", async () => {
    const docker = new InMemoryDocker();
    docker.seedClaudeCliVersion(CTX, IMG, IMAGE_UNSTAMPED);
    const stderr = new StringWriter();
    await warnIfRemoteControlBelowFloor(docker, CTX, IMG, stderr);
    expect(stderr.text()).toBe("");
  });
});

describe("StartCommand — --remote-control end-to-end integration", () => {
  function makeCtx(fs: InMemoryFileSystem): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
    const stdout = new StringWriter();
    const stderr = new StringWriter();
    return {
      stdout, stderr,
      ctx: { fs, env: new EnvResolver({}), cwd: "/p", home: "/home/alan", binName: "dridock", stdout, stderr },
    };
  }

  function seedRunningProject(imageClaudeCliVersion: string): {
    fs: InMemoryFileSystem; docker: InMemoryDocker; runtime: InMemoryContainerRuntime; cmd: StartCommand;
  } {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    colima.seedVm({ name: "cb-abc", status: "Running", address: "192.168.64.13" });
    const docker = new InMemoryDocker();
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.seedImageIdentity(infraContext(), "dridock:latest", { id: "sha256:infra-1", labels: {} });
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    docker.seedImageIdentity("colima-cb-abc", "dridock:latest", { id: "sha256:infra-1", labels: {} });
    docker.seedClaudeCliVersion("colima-cb-abc", "dridock:latest", imageClaudeCliVersion);
    const runtime = new InMemoryContainerRuntime();
    const cmd = new StartCommand("dridock:latest", {
      colima, docker, runtime,
      git: new StubGitToplevel("/p"), hostGit: new StubHostGit(), probe: new StubProcessProbe(),
    });
    return { fs, docker, runtime, cmd };
  }

  test("stale image + --remote-control → warning emitted, container STILL starts (rc 0)", async () => {
    const { fs, runtime, cmd } = seedRunningProject("2.1.100");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--remote-control"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("--remote-control: this project's image ships Claude Code 2.1.100");
    // Container ran regardless — bash-parity ("Continuing anyway").
    expect(runtime.runs.length).toBe(1);
  });

  test("current image + --remote-control → NO warning", async () => {
    const { fs, runtime, cmd } = seedRunningProject("2.5.0");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--remote-control"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toBe("");
    expect(runtime.runs.length).toBe(1);
  });

  test("stale image + NO --remote-control → NO warning (guard only fires on the flag)", async () => {
    const { fs, runtime, cmd } = seedRunningProject("2.1.100");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toBe("");
    expect(runtime.runs.length).toBe(1);
  });

  test("--remote-control-session-name-prefix (decoy) → NO warning even on stale image", async () => {
    const { fs, cmd } = seedRunningProject("2.1.100");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--remote-control-session-name-prefix=foo"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toBe("");
  });
});

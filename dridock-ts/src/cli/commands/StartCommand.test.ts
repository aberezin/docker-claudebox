import { test, expect, describe } from "bun:test";
import { StartCommand, shellQuote } from "./StartCommand.ts";
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
import { DridockError } from "../../domain/errors.ts";
import { infraContext } from "../../infra/Docker.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

/** Standard fixture: project + cb-infra + image seeded, VM absent. */
function seedProjectWithInfra(): {
  fs: InMemoryFileSystem; colima: InMemoryColima; docker: InMemoryDocker; runtime: InMemoryContainerRuntime;
  cmd: StartCommand;
} {
  const fs = new InMemoryFileSystem();
  fs.seed("/p/.dridock/config.yml", "id: abc\n");
  const colima = new InMemoryColima();
  colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
  const docker = new InMemoryDocker();
  docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
  docker.seedImageIdentity(infraContext(), "dridock:latest", { id: "sha256:infra-1", labels: {} });
  const runtime = new InMemoryContainerRuntime();
  const cmd = new StartCommand("dridock:latest", {
    colima, docker, runtime,
    git: new StubGitToplevel("/p"),
    hostGit: new StubHostGit(),
    probe: new StubProcessProbe(),
  });
  return { fs, colima, docker, runtime, cmd };
}

/** Same but with the project VM ALREADY running (no cold-start needed). */
function seedProjectVmRunning(): ReturnType<typeof seedProjectWithInfra> {
  const b = seedProjectWithInfra();
  b.colima.seedVm({ name: "cb-abc", status: "Running", address: "192.168.64.13" });
  b.docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
  b.docker.seedImageIdentity("colima-cb-abc", "dridock:latest", { id: "sha256:infra-1", labels: {} });
  return b;
}

describe("StartCommand — guards", () => {
  test("cwd inside .dridock/ → rc 1 with cd advice", async () => {
    const fs = new InMemoryFileSystem();
    const cmd = new StartCommand("dridock:latest", {
      colima: new InMemoryColima(), docker: new InMemoryDocker(), runtime: new InMemoryContainerRuntime(),
      git: new StubGitToplevel("/proj"), hostGit: new StubHostGit(), probe: new StubProcessProbe(),
    });
    const { ctx, stderr } = makeCtx(fs, "/proj/.dridock");
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("inside a '.dridock'");
  });

  test("no config.yml → rc 1 + bootstrap hint", async () => {
    const fs = new InMemoryFileSystem();
    const cmd = new StartCommand("dridock:latest", {
      colima: new InMemoryColima(), docker: new InMemoryDocker(), runtime: new InMemoryContainerRuntime(),
      git: new StubGitToplevel("/p"), hostGit: new StubHostGit(), probe: new StubProcessProbe(),
    });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no dridock project here");
  });
});

describe("StartCommand — VM cold-start (P4b — no more bash stub)", () => {
  test("VM absent + cb-infra ready → colima start invoked, image seeded, container run", async () => {
    const { colima, docker, runtime, cmd, fs } = seedProjectWithInfra();
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(0);
    // Colima started the project VM
    expect(colima.starts.map((s) => s.profile)).toContain("cb-abc");
    // Image was seeded from cb-infra to the project context
    expect(docker.saves).toContainEqual({ source: infraContext(), image: "dridock:latest", target: "colima-cb-abc" });
    // Container run happened
    expect(runtime.runs.length).toBe(1);
  });

  test("VM absent + cb-infra NOT seeded → rc 1 with 'build the image' hint (no docker run)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const runtime = new InMemoryContainerRuntime();
    const cmd = new StartCommand("dridock:latest", {
      colima: new InMemoryColima(), docker: new InMemoryDocker(), runtime,
      git: new StubGitToplevel("/p"), hostGit: new StubHostGit(), probe: new StubProcessProbe(),
    });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("VM start failed");
    expect(runtime.runs).toEqual([]);
  });

  test("VM already running → no colima start, container runs directly", async () => {
    const { colima, runtime, cmd, fs } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(0);
    // No `colima start cb-abc` — VM was already up
    expect(colima.starts.map((s) => s.profile)).not.toContain("cb-abc");
    expect(runtime.runs.length).toBe(1);
  });
});

describe("StartCommand — full argv-parity (all P4b sidecars + mounts + env)", () => {
  test("run recorded with host network, per-project data-dir mount, all essential env", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    const run = runtime.runs[0]!;
    expect(run.network).toBe("host");
    // Per-project data dir mount
    expect(run.mounts).toContainEqual({ host: "/home/alan/.config/dridock/projects/abc/claude", container: "/home/claude/.claude" });
    // NOT host global
    expect(run.mounts).not.toContainEqual({ host: "/home/alan/.claude", container: "/home/claude/.claude" });
    // Framework-bugs + consult mounts
    expect(run.mounts).toContainEqual({ host: "/home/alan/.config/dridock/framework-bugs", container: "/home/claude/framework-bugs" });
    expect(run.mounts).toContainEqual({ host: "/home/alan/.config/dridock/consult", container: "/home/claude/framework-consult" });
    // Essential env
    expect(run.env).toContainEqual({ key: "DRIDOCK_WORKSPACE", value: "/p" });
    expect(run.env).toContainEqual({ key: "DRIDOCK_PROJECT_ID", value: "abc" });
    expect(run.env).toContainEqual({ key: "DRIDOCK_CONTAINER_NAME", value: "claude-_p" });
    expect(run.env).toContainEqual({ key: "DRIDOCK_FRAMEWORK_BUGS_DIR", value: "/home/claude/framework-bugs" });
    expect(run.env).toContainEqual({ key: "DRIDOCK_CONSULT_DIR", value: "/home/claude/framework-consult" });
    expect(run.env).toContainEqual({ key: "DRIDOCK_VM_IP", value: "192.168.64.13" });
    // Command is bare (entrypoint prepends `claude`)
    expect(run.cmd).not.toContain("claude");
  });

  test("auth sidecars written for all three roles under the data dir", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    // Set the env values the auth sidecar reads
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-abc";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "oauth-test-xyz";
    try {
      await cmd.run([], ctx);
      for (const suffix of ["", "_prog", "_cron"]) {
        const path = `/home/alan/.config/dridock/projects/abc/claude/.claude-_p${suffix}-auth`;
        expect(await fs.readText(path)).toContain("ANTHROPIC_API_KEY=sk-ant-test-abc");
        expect(await fs.readText(path)).toContain("CLAUDE_CODE_OAUTH_TOKEN=oauth-test-xyz");
        expect(fs.modeOf(path)).toBe(0o600);
      }
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    }
  });

  test("secrets sidecars copy .dridock/secrets.env into all three roles", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    fs.seed("/p/.dridock/secrets.env", "GH_TOKEN=ghp_test\n", { mode: 0o600 });
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    for (const suffix of ["", "_prog", "_cron"]) {
      const path = `/home/alan/.config/dridock/projects/abc/claude/.claude-_p${suffix}-secrets`;
      expect(await fs.readText(path)).toBe("GH_TOKEN=ghp_test\n");
      expect(fs.modeOf(path)).toBe(0o600);
    }
  });

  test("VM-IP sidecar written with the wait-reachable IP", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    const path = "/home/alan/.config/dridock/projects/abc/claude/.claude-_p_prog-vmip";
    expect(await fs.readText(path)).toContain("DRIDOCK_VM_IP=192.168.64.13");
    expect(fs.modeOf(path)).toBe(0o644);
  });

  test("network.hostname from config.yml surfaces in vmip sidecar + DRIDOCK_HOSTNAME env", async () => {
    const { fs, runtime, cmd } = seedProjectVmRunning();
    // Replace project config with hostname
    fs.seed("/p/.dridock/config.yml", "id: abc\nnetwork:\n  hostname: my-project\n");
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    const path = "/home/alan/.config/dridock/projects/abc/claude/.claude-_p-vmip";
    expect(await fs.readText(path)).toContain("DRIDOCK_HOSTNAME=my-project");
    expect(runtime.runs[0]!.env).toContainEqual({ key: "DRIDOCK_HOSTNAME", value: "my-project" });
  });

  test("empty CDP + hostagent sidecars written when bridges are down (bash 'always write' pattern)", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    for (const suffix of ["", "_prog", "_cron"]) {
      expect(await fs.readText(`/home/alan/.config/dridock/projects/abc/claude/.claude-_p${suffix}-cdp`)).toBe("");
      // host-agent sidecar always has the two vars, empty when down
      expect(await fs.readText(`/home/alan/.config/dridock/projects/abc/claude/.claude-_p${suffix}-hostagent`))
        .toBe("DRIDOCK_HOST_AGENT_URL=\nDRIDOCK_HOST_AGENT_TOKEN=\n");
    }
  });

  test("CDP marker present → cdp sidecar populated + DRIDOCK_HOST_CDP_URL env", async () => {
    const { fs, runtime, cmd } = seedProjectVmRunning();
    fs.seed("/home/alan/.config/dridock/projects/abc/.cdp-url", "http://192.168.64.1:9223\n");
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc/claude/.claude-_p-cdp")).toContain("DRIDOCK_HOST_CDP_URL=http://192.168.64.1:9223");
    expect(runtime.runs[0]!.env).toContainEqual({ key: "DRIDOCK_HOST_CDP_URL", value: "http://192.168.64.1:9223" });
  });

  test("DRIDOCK_ENV_FOO=bar → -e FOO=bar + entry in -env sidecar", async () => {
    const { fs, runtime, cmd } = seedProjectVmRunning();
    process.env["DRIDOCK_ENV_MY_VAR"] = "hello";
    try {
      const { ctx } = makeCtx(fs);
      await cmd.run([], ctx);
      expect(runtime.runs[0]!.env).toContainEqual({ key: "MY_VAR", value: "hello" });
      expect(await fs.readText("/home/alan/.config/dridock/projects/abc/claude/.claude-_p_prog-env")).toBe("MY_VAR=hello\n");
    } finally {
      delete process.env["DRIDOCK_ENV_MY_VAR"];
    }
  });

  test("DRIDOCK_MOUNT_SCRATCH=/opt → -v /opt:/opt added to mounts", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    process.env["DRIDOCK_MOUNT_SCRATCH"] = "/opt/scratch";
    try {
      const { ctx } = makeCtx(fs);
      await cmd.run([], ctx);
      expect(runtime.runs[0]!.mounts).toContainEqual({ host: "/opt/scratch", container: "/opt/scratch" });
    } finally {
      delete process.env["DRIDOCK_MOUNT_SCRATCH"];
    }
  });

  test("DRIDOCK_GIT_NAME/EMAIL sourced from HostGit config", async () => {
    const { colima, docker, runtime, fs } = seedProjectVmRunning();
    const hostGit = new StubHostGit();
    hostGit.seedConfig("user.name", "Alan Berezin");
    hostGit.seedConfig("user.email", "alan@example.com");
    const cmd = new StartCommand("dridock:latest", {
      colima, docker, runtime,
      git: new StubGitToplevel("/p"), hostGit, probe: new StubProcessProbe(),
    });
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    expect(runtime.runs[0]!.env).toContainEqual({ key: "DRIDOCK_GIT_NAME", value: "Alan Berezin" });
    expect(runtime.runs[0]!.env).toContainEqual({ key: "DRIDOCK_GIT_EMAIL", value: "alan@example.com" });
  });

  test("DRIDOCK_TMPFS_TMP=2g → --tmpfs /tmp:size=2g,exec,mode=1777", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    process.env["DRIDOCK_TMPFS_TMP"] = "2g";
    try {
      const { ctx } = makeCtx(fs);
      await cmd.run([], ctx);
      expect(runtime.runs[0]!.tmpfs).toContain("/tmp:size=2g,exec,mode=1777");
    } finally {
      delete process.env["DRIDOCK_TMPFS_TMP"];
    }
  });

  test("DRIDOCK_TMPFS_TMP=1 → shorthand expands to 2g", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    process.env["DRIDOCK_TMPFS_TMP"] = "1";
    try {
      const { ctx } = makeCtx(fs);
      await cmd.run([], ctx);
      expect(runtime.runs[0]!.tmpfs).toContain("/tmp:size=2g,exec,mode=1777");
    } finally {
      delete process.env["DRIDOCK_TMPFS_TMP"];
    }
  });

  test("features list from config.yml → written to .features sidecar", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [typescript, python]\n");
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc/claude/.features"))
      .toBe("typescript python\n");
  });
});

describe("StartCommand — programmatic path with all fidelity", () => {
  test("valid -p reaches _prog container with validated args, DRIDOCK_CONTAINER_NAME per-role", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run(["-p", "hello world"], ctx);
    expect(rc).toBe(0);
    const run = runtime.runs[0]!;
    expect(run.containerName).toBe("claude-_p_prog");
    expect(run.mode).toBe("attached");
    // Bare cmd (entrypoint prepends claude)
    expect(run.cmd).not.toContain("claude");
    expect(run.cmd).toContain("-p");
    expect(run.cmd).toContain("hello world");
    // DRIDOCK_CONTAINER_NAME wired to the _prog variant (matches bash's per-run override at :3288)
    const containerNameEntries = run.env.filter((e) => e.key === "DRIDOCK_CONTAINER_NAME");
    expect(containerNameEntries[containerNameEntries.length - 1]?.value).toBe("claude-_p_prog");
  });

  test("second -p reuses via _prog args sidecar + startAttached (no name collision)", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    runtime.seedPs("claude-_p_prog", { name: "claude-_p_prog", status: "Exited (0) 3m", image: "dridock:latest" });
    const { ctx } = makeCtx(fs);
    await cmd.run(["-p", "hi again"], ctx);
    expect(runtime.runs).toEqual([]);
    expect(runtime.starts).toEqual([{ context: "colima-cb-abc", container: "claude-_p_prog" }]);
    const argsFile = await fs.readText("/home/alan/.config/dridock/projects/abc/claude/.claude-_p_prog-args");
    expect(argsFile).toContain("hi again");
  });

  test("-p --update → writes _prog-update sidecar", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    await cmd.run(["-p", "hi", "--update"], ctx);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/claude/.claude-_p_prog-update")).toBe(true);
  });
});

describe("StartCommand — interactive path with sidecars", () => {
  test("interactive with --no-continue writes the sidecar; without removes it", async () => {
    const { fs, cmd } = seedProjectVmRunning();
    // Seed a stale sidecar to prove we remove it on the no-flag path
    fs.seed("/home/alan/.config/dridock/projects/abc/claude/.claude-_p-no-continue", "");
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);   // no --no-continue → removed
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/claude/.claude-_p-no-continue")).toBe(false);
    // With --no-continue → written
    await cmd.run(["--no-continue"], ctx);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/claude/.claude-_p-no-continue")).toBe(true);
  });

  test("interactive extra args written to sidecar (excluding wrapper-only flags)", async () => {
    const { runtime, cmd, fs } = seedProjectVmRunning();
    const { ctx } = makeCtx(fs);
    await cmd.run(["--resume", "--update"], ctx);
    const sidecar = await fs.readText("/home/alan/.config/dridock/projects/abc/claude/.claude-_p-interactive-args");
    expect(sidecar).toContain("--resume");
    expect(sidecar).not.toContain("--update"); // wrapper flag, not passed to claude
    // Container CMD stays bare
    expect(runtime.runs[0]!.cmd).not.toContain("--resume");
  });
});

describe("StartCommand — validator rejections still fire before any side effect", () => {
  test("VM down + invalid --effort → rc 1 rejection (validator runs BEFORE ensure)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const cmd = new StartCommand("dridock:latest", {
      colima: new InMemoryColima(), docker: new InMemoryDocker(), runtime: new InMemoryContainerRuntime(),
      git: new StubGitToplevel("/p"), hostGit: new StubHostGit(), probe: new StubProcessProbe(),
    });
    const { ctx } = makeCtx(fs);
    try {
      await cmd.run(["-p", "hi", "--effort", "hihg"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as DridockError).exitCode).toBe(1);
      expect((e as Error).message).toContain("Invalid effort");
    }
  });
});

describe("shellQuote — bash %q parity", () => {
  test("simple args", () => expect(shellQuote(["-p", "hello"])).toBe("'-p' 'hello'"));
  test("embedded single quote", () => expect(shellQuote(["it's"])).toBe(`'it'\\''s'`));
  test("empty", () => expect(shellQuote(["a", "", "b"])).toBe("'a' '' 'b'"));
});

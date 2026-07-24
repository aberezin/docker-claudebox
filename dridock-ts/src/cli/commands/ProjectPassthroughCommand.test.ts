import { test, expect, describe } from "bun:test";
import { McpCommand, AuthCommand } from "./ProjectPassthroughCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { infraContext } from "../../infra/Docker.ts";
import { buildRunArgv } from "../../infra/ContainerRuntime.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

function seedReadyProject(): {
  fs: InMemoryFileSystem; colima: InMemoryColima; docker: InMemoryDocker; runtime: InMemoryContainerRuntime;
} {
  const fs = new InMemoryFileSystem();
  fs.seed("/p/.dridock/config.yml", "id: abc\n");
  const colima = new InMemoryColima();
  colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
  colima.seedVm({ name: "cb-abc", status: "Running", address: "192.168.64.13" });
  const docker = new InMemoryDocker();
  docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
  docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
  docker.seedImageIdentity(infraContext(), "dridock:latest", { id: "sha256:X", labels: {} });
  docker.seedImageIdentity("colima-cb-abc", "dridock:latest", { id: "sha256:X", labels: {} });
  const runtime = new InMemoryContainerRuntime();
  return { fs, colima, docker, runtime };
}

describe("ProjectPassthroughCommand — #39 fix: correct project scope + HOME + mount", () => {
  test("mcp: routes to PROJECT context, not cb-infra", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["add", "testsrv", "--", "echo", "hi"], ctx);
    const run = runtime.runs[0]!;
    // Docker context is the PROJECT VM's, NOT cb-infra
    expect(run.context).toBe("colima-cb-abc");
    expect(run.context).not.toBe(infraContext());
  });

  test("mcp: mounts the PER-PROJECT data dir at /home/claude/.claude (not host global, not absent)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["list"], ctx);
    const run = runtime.runs[0]!;
    // The #39 heart: the data-dir mount MUST be present so
    // .claude.json writes land somewhere persistent.
    expect(run.mounts).toContainEqual({ host: "/home/alan/.config/dridock/projects/abc/claude", container: "/home/claude/.claude" });
    // NOT the host global (would leak the human's config INTO project scope)
    expect(run.mounts).not.toContainEqual({ host: "/home/alan/.claude", container: "/home/claude/.claude" });
  });

  test("mcp: sets HOME=/home/claude + CLAUDE_CONFIG_DIR=/home/claude/.claude (the #39 fix)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["add", "testsrv", "--", "echo", "hi"], ctx);
    const run = runtime.runs[0]!;
    // Without these two env vars, `claude` runs as root with HOME=/root
    // and writes .claude.json to /root/.claude.json (outside the mount,
    // ephemeral with --rm). #39 root cause. THIS IS THE FIX.
    expect(run.env).toContainEqual({ key: "HOME", value: "/home/claude" });
    expect(run.env).toContainEqual({ key: "CLAUDE_CONFIG_DIR", value: "/home/claude/.claude" });
  });

  test("mcp: throwaway shape (--rm + --entrypoint claude)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["list"], ctx);
    const run = runtime.runs[0]!;
    expect(run.removeAfter).toBe(true);
    expect(run.entrypoint).toBe("claude");
    // Derived argv includes --rm + --entrypoint claude
    const argv = buildRunArgv(run);
    expect(argv).toContain("--rm");
    expect(argv).toContain("--entrypoint");
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("claude");
  });

  test("mcp: cmd = [verb, ...args] — bare claude args (entrypoint gives us the claude binary)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["add", "testsrv", "--", "echo", "hi"], ctx);
    const run = runtime.runs[0]!;
    expect(run.cmd).toEqual(["mcp", "add", "testsrv", "--", "echo", "hi"]);
  });

  test("mcp: mode is 'attached' — works headless (mcp add/remove/list don't need TTY)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["list"], ctx);
    expect(runtime.runs[0]!.mode).toBe("attached");
    // Sanity: argv has NEITHER -it nor -d (attached shape)
    const argv = buildRunArgv(runtime.runs[0]!);
    expect(argv).not.toContain("-it");
    expect(argv).not.toContain("-d");
  });

  test("auth: mode is 'interactive' — auth login needs TTY for browser OAuth callback", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new AuthCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["login"], ctx);
    expect(runtime.runs[0]!.mode).toBe("interactive");
    const argv = buildRunArgv(runtime.runs[0]!);
    expect(argv).toContain("-it");
  });

  test("no config.yml → rc 1 with 'needs project context' hint (mcp/auth are project-scoped)", async () => {
    const fs = new InMemoryFileSystem();
    // NO config.yml
    const cmd = new McpCommand("dridock:latest", {
      colima: new InMemoryColima(), docker: new InMemoryDocker(),
      runtime: new InMemoryContainerRuntime(), git: new StubGitToplevel("/p"),
    });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["list"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no dridock project here");
    expect(stderr.text()).toContain("needs a project context");
  });

  test("VM absent + cb-infra can't seed → rc 1 (VmEnsure guards uphold)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    // No cb-infra seeded → VmEnsure's requireImageSource path fails
    const cmd = new McpCommand("dridock:latest", {
      colima: new InMemoryColima(), docker: new InMemoryDocker(),
      runtime: new InMemoryContainerRuntime(), git: new StubGitToplevel("/p"),
    });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["list"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("VM start failed");
  });

  test("bash-parity: existing DOCKER_ARGS mounts are all present (ssh, workspace, docker socket)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["list"], ctx);
    const run = runtime.runs[0]!;
    expect(run.mounts).toContainEqual({ host: "/home/alan/.ssh/claudebox", container: "/home/claude/.ssh" });
    expect(run.mounts).toContainEqual({ host: "/p", container: "/p" });
    expect(run.mounts).toContainEqual({ host: "/var/run/docker.sock", container: "/var/run/docker.sock" });
    // network: host — same as start
    expect(run.network).toBe("host");
  });

  test("container name is unique per invocation (throwaway; --rm cleans up on exit)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    await cmd.run(["list"], ctx);
    // Container name includes the verb and a timestamp — never
    // collides with the persistent claudebot container name.
    const run = runtime.runs[0]!;
    expect(run.containerName).toMatch(/^claude-_p_mcp_\d+$/);
    // Explicitly NOT the persistent interactive name (would race)
    expect(run.containerName).not.toBe("claude-_p");
    expect(run.containerName).not.toBe("claude-_p_prog");
  });

  test("#40 fix: workdir = ctx.cwd → -w in argv → claude runs in the REAL workspace path (not /workspace)", async () => {
    // Regression for #40. Without -w, `--entrypoint claude` lands in
    // the image's default WORKDIR (/workspace) and local-scope `mcp
    // add` keys under `.projects["/workspace"]` — where the real
    // claudebot never looks. The fix: set `workdir: ctx.cwd` so the
    // container runs in the same path StartCommand's entrypoint would
    // `cd` to. Verified via the derived argv (must contain `-w
    // <ctx.cwd>`).
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs, "/Users/alan/dev/gammaray");
    // Match the seeded project id resolution — the fixture uses cwd "/p"
    // but this test uses a real-looking path; re-seed the git toplevel
    // + a config.yml at that path so ProjectRoot resolves correctly.
    fs.seed("/Users/alan/dev/gammaray/.dridock/config.yml", "id: abc\n");
    const cmd2 = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/Users/alan/dev/gammaray") });
    await cmd2.run(["add", "testsrv", "--", "echo", "hi"], ctx);
    const run = runtime.runs[0]!;
    expect(run.workdir).toBe("/Users/alan/dev/gammaray");
    // Derived argv includes -w <real-path>
    const { buildRunArgv } = await import("../../infra/ContainerRuntime.ts");
    const argv = buildRunArgv(run);
    expect(argv).toContain("-w");
    expect(argv[argv.indexOf("-w") + 1]).toBe("/Users/alan/dev/gammaray");
    // Must NOT be the image's default /workspace (the bug)
    expect(argv[argv.indexOf("-w") + 1]).not.toBe("/workspace");
    // Suppress unused
    void cmd;
  });

  test("ANTHROPIC_API_KEY passthrough when set; not when unset (no stray leak)", async () => {
    const { fs, colima, docker, runtime } = seedReadyProject();
    const cmd = new McpCommand("dridock:latest", { colima, docker, runtime, git: new StubGitToplevel("/p") });
    const { ctx } = makeCtx(fs);
    const orig = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      await cmd.run(["list"], ctx);
      expect(runtime.runs[0]!.env.find((e) => e.key === "ANTHROPIC_API_KEY")).toBeUndefined();
    } finally {
      if (orig !== undefined) process.env["ANTHROPIC_API_KEY"] = orig;
    }
    // Now with it set
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-abc";
    try {
      runtime.runs.length = 0;
      await cmd.run(["list"], ctx);
      expect(runtime.runs[0]!.env).toContainEqual({ key: "ANTHROPIC_API_KEY", value: "sk-ant-abc" });
    } finally {
      if (orig === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = orig;
    }
  });
});

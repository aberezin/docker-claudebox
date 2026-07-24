import { test, expect, describe, afterEach } from "bun:test";
import { CronModeCommand, cronModeRequested } from "./CronModeCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { infraContext, projectContext } from "../../infra/Docker.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

/**
 * Standard fixture — project seeded, cb-infra ready, project VM +
 * image both present. Isolates the cron-specific behavior from the
 * "no VM yet" path (also covered below).
 */
function seedProject(): {
  fs: InMemoryFileSystem; colima: InMemoryColima; docker: InMemoryDocker; runtime: InMemoryContainerRuntime;
  cmd: CronModeCommand;
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
  const runtime = new InMemoryContainerRuntime();
  const cmd = new CronModeCommand("dridock:latest", {
    colima, docker, runtime, git: new StubGitToplevel("/p"),
  });
  return { fs, colima, docker, runtime, cmd };
}

// process.env-based knobs the cron dispatch reads. Snapshot + restore.
const ENV_KEYS = [
  "DRIDOCK_MODE_CRON", "CLAUDE_MODE_CRON", "DRIDOCK_MODE_CRON_FILE", "CLAUDE_MODE_CRON_FILE",
  "DRIDOCK_DATA_DIR", "CLAUDE_DATA_DIR", "DEBUG", "XDG_CONFIG_HOME",
] as const;
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in savedEnv)) continue;
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
});
function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe("cronModeRequested — env-var gate", () => {
  test("DRIDOCK_MODE_CRON=1 → true", () => {
    expect(cronModeRequested({ DRIDOCK_MODE_CRON: "1" })).toBe(true);
  });
  test("legacy CLAUDE_MODE_CRON=1 → true (bash-parity fallback)", () => {
    expect(cronModeRequested({ CLAUDE_MODE_CRON: "1" })).toBe(true);
  });
  test("empty string → false (must be non-empty, matches bash's `[ -n \"$_mode_cron\" ]`)", () => {
    expect(cronModeRequested({ DRIDOCK_MODE_CRON: "" })).toBe(false);
  });
  test("unset → false", () => {
    expect(cronModeRequested({})).toBe(false);
  });
});

describe("CronModeCommand — fresh spawn (no existing container)", () => {
  test("bare invocation → docker run -d with DRIDOCK_MODE_CRON=1 in env", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const { runtime, cmd, fs } = seedProject();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(0);
    expect(runtime.runs.length).toBe(1);
    const run = runtime.runs[0]!;
    expect(run.mode).toBe("detached");
    expect(run.containerName).toBe("claude-_p_cron");
    expect(run.context).toBe(projectContext("abc"));
    expect(run.env).toContainEqual({ key: "DRIDOCK_MODE_CRON", value: "1" });
    expect(run.env).toContainEqual({ key: "DRIDOCK_CONTAINER_NAME", value: "claude-_p_cron" });
    expect(stdout.text()).toContain("starting cron container (claude-_p_cron)");
    expect(stdout.text()).toContain("docker --context colima-cb-abc logs -f claude-_p_cron");
  });

  test("DRIDOCK_MODE_CRON_FILE=/etc/cron.yml → forwarded as -e", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    setEnv("DRIDOCK_MODE_CRON_FILE", "/etc/cron.yml");
    const { runtime, cmd, fs } = seedProject();
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    expect(runtime.runs[0]!.env).toContainEqual({ key: "DRIDOCK_MODE_CRON_FILE", value: "/etc/cron.yml" });
  });

  test("DEBUG=true → forwarded as -e; DEBUG unset → NOT forwarded", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    setEnv("DEBUG", "true");
    const { runtime, cmd, fs } = seedProject();
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    expect(runtime.runs[0]!.env).toContainEqual({ key: "DEBUG", value: "true" });
  });
});

describe("CronModeCommand — existing container branches", () => {
  test("cron container ALREADY running → prints 'already running' + logs hint, rc 0, no run/start", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const { runtime, cmd, fs } = seedProject();
    runtime.seedPs("claude-_p_cron", { name: "claude-_p_cron", status: "Up 5 minutes", image: "dridock:latest" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(0);
    expect(runtime.runs).toEqual([]);
    expect(runtime.backgroundStarts).toEqual([]);
    expect(stdout.text()).toContain("cron already running (claude-_p_cron)");
    expect(stdout.text()).toContain("docker --context colima-cb-abc logs -f claude-_p_cron");
  });

  test("cron container EXISTS but stopped → docker start (background, no attach), NO fresh run", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const { runtime, cmd, fs } = seedProject();
    runtime.seedPs("claude-_p_cron", { name: "claude-_p_cron", status: "Exited (0) 2 hours ago", image: "dridock:latest" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(0);
    expect(runtime.runs).toEqual([]);
    expect(runtime.backgroundStarts).toEqual([{ context: "colima-cb-abc", container: "claude-_p_cron" }]);
    expect(runtime.starts).toEqual([]); // NOT startAttached — cron is detached
    expect(stdout.text()).toContain("restarting cron container (claude-_p_cron)");
  });
});

describe("CronModeCommand — stop sub-command", () => {
  test("`stop` + cron running → docker stop, prints stopped message", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const { runtime, cmd, fs } = seedProject();
    runtime.seedPs("claude-_p_cron", { name: "claude-_p_cron", status: "Up 5 minutes", image: "dridock:latest" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run(["stop"], ctx);
    expect(rc).toBe(0);
    expect(runtime.stops).toEqual([{ context: "colima-cb-abc", container: "claude-_p_cron" }]);
    expect(stdout.text()).toContain("stopped claude-_p_cron");
  });

  test("`stop` + cron NOT running → 'cron not running', rc 0, no docker stop", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const { runtime, cmd, fs } = seedProject();
    // No seedPs → psFilter returns undefined
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run(["stop"], ctx);
    expect(rc).toBe(0);
    expect(runtime.stops).toEqual([]);
    expect(stdout.text()).toContain("cron not running");
  });

  test("`stop` + project VM DOWN → 'cron not running' (no docker call attempted)", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    // Only cb-infra — cb-abc absent = VM down
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    const docker = new InMemoryDocker();
    const runtime = new InMemoryContainerRuntime();
    const cmd = new CronModeCommand("dridock:latest", {
      colima, docker, runtime, git: new StubGitToplevel("/p"),
    });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run(["stop"], ctx);
    expect(rc).toBe(0);
    expect(runtime.stops).toEqual([]);
    expect(stdout.text()).toContain("cron not running");
  });
});

describe("CronModeCommand — guards", () => {
  test("no project → rc 1 stderr 'no dridock project here'", async () => {
    setEnv("DRIDOCK_MODE_CRON", "1");
    const fs = new InMemoryFileSystem();
    const cmd = new CronModeCommand("dridock:latest", {
      colima: new InMemoryColima(),
      docker: new InMemoryDocker(),
      runtime: new InMemoryContainerRuntime(),
      git: new StubGitToplevel(undefined),
    });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no dridock project here");
    expect(stderr.text()).toContain("cron mode needs a project context");
  });
});

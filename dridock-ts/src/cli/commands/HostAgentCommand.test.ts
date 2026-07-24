import { test, expect, describe, afterEach } from "bun:test";
import { HostAgentCommand } from "./HostAgentCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryHostProcessManager } from "../../test/fakes/InMemoryHostProcessManager.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

function makeCtx(fs: InMemoryFileSystem): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd: "/anywhere", home: "/home/alan", binName: "dridock-ts", stdout, stderr },
  };
}

const ENV_KEYS = ["XDG_CONFIG_HOME", "DRIDOCK_HOST_AGENT_PY", "DRIDOCK_HOST_AGENT_PORT", "DRIDOCK_HOST_AGENT_BIND"] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in saved)) continue;
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

const PY = "/usr/local/bin/host-agent.py";

describe("HostAgentCommand — arg validation", () => {
  test("no subcommand → usage + rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HostAgentCommand({ pyCandidates: [PY] }).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage: dridock-ts host-agent up|down|status");
  });

  test("invalid subcommand → usage + rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HostAgentCommand({ pyCandidates: [PY] }).run(["restart"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("up|down|status");
  });
});

describe("HostAgentCommand.up", () => {
  test("py present + fresh → rc 0, prints 'up' notice, spawn happens with token", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed(PY, "# stub");
    const processes = new InMemoryHostProcessManager();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HostAgentCommand({
      processes, pyCandidates: [PY],
      sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["up"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("🛰  host agent up on 192.168.64.1:9280");
    expect(stdout.text()).toContain("dridock-ts host-agent down");
    expect(processes.spawns).toHaveLength(1);
  });

  test("py missing → rc 1, stderr lists searched candidates", async () => {
    const fs = new InMemoryFileSystem();
    // Do not seed PY.
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HostAgentCommand({
      pyCandidates: ["/nope/host-agent.py"],
      sleep: async () => {}, randomHex: () => "x".repeat(48),
    }).run(["up"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("host-agent.py not found");
    expect(stderr.text()).toContain("/nope/host-agent.py");
  });

  test("already up → rc 0, 'already up' notice, no re-spawn", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed(PY, "# stub");
    const processes = new InMemoryHostProcessManager();
    // Prior up on record.
    await new HostAgentCommand({
      processes, pyCandidates: [PY],
      sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["up"], makeCtx(fs).ctx);
    expect(processes.spawns).toHaveLength(1);
    // Second up.
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HostAgentCommand({
      processes, pyCandidates: [PY],
      sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["up"], ctx);
    expect(rc).toBe(0);
    expect(processes.spawns).toHaveLength(1);   // no additional spawn
    expect(stdout.text()).toContain("already up");
  });
});

describe("HostAgentCommand.down", () => {
  test("running → rc 0, kills pid + removes files, prints 'down' notice", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed(PY, "# stub");
    const processes = new InMemoryHostProcessManager();
    // Bring up first.
    await new HostAgentCommand({
      processes, pyCandidates: [PY], sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["up"], makeCtx(fs).ctx);
    // Down.
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HostAgentCommand({
      processes, pyCandidates: [PY], sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["down"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("🛰  host agent down");
    expect(processes.alive.size).toBe(0);
  });
});

describe("HostAgentCommand.status", () => {
  test("running → 'host agent: UP' with bind:port + pid", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed(PY, "# stub");
    const processes = new InMemoryHostProcessManager();
    // Bring up first.
    await new HostAgentCommand({
      processes, pyCandidates: [PY], sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["up"], makeCtx(fs).ctx);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HostAgentCommand({
      processes, pyCandidates: [PY], sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["status"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("host agent: UP (192.168.64.1:9280, pid 1000)");
  });

  test("not running → 'host agent: down' with the up hint using ctx.binName", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HostAgentCommand({
      pyCandidates: [PY], sleep: async () => {}, randomHex: () => "cd".repeat(24),
    }).run(["status"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("host agent: down");
    expect(stdout.text()).toContain("dridock-ts host-agent up");
  });
});

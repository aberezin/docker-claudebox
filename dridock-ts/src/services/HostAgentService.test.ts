import { test, expect, describe } from "bun:test";
import { HostAgentService } from "./HostAgentService.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { InMemoryHostProcessManager } from "../test/fakes/InMemoryHostProcessManager.ts";

const XDG = "/home/alan/.config";
const HOME = "/home/alan";
const AGENT_HOME = `${XDG}/dridock/host-agent`;

function build(overrides: {
  env?: Record<string, string | undefined>;
  pyCandidates?: readonly string[];
  pyPresent?: string;
} = {}): {
  svc: HostAgentService;
  fs: InMemoryFileSystem;
  processes: InMemoryHostProcessManager;
} {
  const fs = new InMemoryFileSystem();
  const py = overrides.pyPresent ?? "/usr/local/bin/host-agent.py";
  if (overrides.pyPresent !== null) fs.seed(py, "# host-agent.py stub");
  const processes = new InMemoryHostProcessManager();
  const svc = new HostAgentService({
    fs, processes,
    env: { XDG_CONFIG_HOME: XDG, ...overrides.env },
    home: HOME,
    pyCandidates: overrides.pyCandidates ?? [py],
    randomHex: (n) => "cd".repeat(n),   // deterministic → 48 chars for 24 bytes
    sleep: async () => {},
  });
  return { svc, fs, processes };
}

describe("HostAgentService.up — happy path", () => {
  test("spawns python3 with token env, writes pid + token, returns 'up'", async () => {
    const { svc, fs, processes } = build();
    const out = await svc.up();
    expect(out.kind).toBe("up");
    if (out.kind !== "up") return;
    expect(out.pid).toBe(1000);
    expect(out.bind).toBe("192.168.64.1");
    expect(out.port).toBe("9280");

    expect(processes.spawns).toHaveLength(1);
    const spawn = processes.spawns[0]!;
    expect(spawn.argv).toEqual(["python3", "/usr/local/bin/host-agent.py"]);
    // The three CB_* env vars the daemon reads.
    expect(spawn.opts.env?.["CB_HOST_AGENT_TOKEN"]).toBe("cd".repeat(24));
    expect(spawn.opts.env?.["CB_HOST_AGENT_BIND"]).toBe("192.168.64.1");
    expect(spawn.opts.env?.["CB_HOST_AGENT_PORT"]).toBe("9280");

    // On-disk state.
    expect((await fs.readText(`${AGENT_HOME}/pid`)).trim()).toBe("1000");
    expect(await fs.readText(`${AGENT_HOME}/token`)).toBe("cd".repeat(24));
  });

  test("DRIDOCK_HOST_AGENT_BIND / PORT overrides applied to env + returned outcome", async () => {
    const { svc, processes } = build({
      env: {
        DRIDOCK_HOST_AGENT_BIND: "10.0.0.5",
        DRIDOCK_HOST_AGENT_PORT: "19280",
      },
    });
    const out = await svc.up();
    expect(out.kind).toBe("up");
    if (out.kind !== "up") return;
    expect(out.bind).toBe("10.0.0.5");
    expect(out.port).toBe("19280");
    expect(processes.spawns[0]!.opts.env?.["CB_HOST_AGENT_BIND"]).toBe("10.0.0.5");
    expect(processes.spawns[0]!.opts.env?.["CB_HOST_AGENT_PORT"]).toBe("19280");
  });
});

describe("HostAgentService.up — already-up short-circuit", () => {
  test("existing pid alive → 'already-up' with that pid, no new spawn", async () => {
    const { svc, fs, processes } = build();
    fs.seed(`${AGENT_HOME}/pid`, "42");
    processes.alive.add(42);
    const out = await svc.up();
    expect(out.kind).toBe("already-up");
    if (out.kind !== "already-up") return;
    expect(out.pid).toBe(42);
    expect(processes.spawns).toEqual([]);
  });

  test("existing pid DEAD (stale pid file) → fresh spawn, token replaced", async () => {
    const { svc, fs, processes } = build();
    fs.seed(`${AGENT_HOME}/pid`, "42");
    // Do NOT add 42 to alive.
    const out = await svc.up();
    expect(out.kind).toBe("up");
    expect(processes.spawns).toHaveLength(1);
    expect((await fs.readText(`${AGENT_HOME}/pid`)).trim()).toBe("1000"); // overwritten
  });
});

describe("HostAgentService.up — failure paths", () => {
  test("py-not-found: none of the candidates exist → returns py-not-found (surfaces candidates)", async () => {
    // Don't seed the py file.
    const fs = new InMemoryFileSystem();
    const processes = new InMemoryHostProcessManager();
    const svc = new HostAgentService({
      fs, processes,
      env: { XDG_CONFIG_HOME: XDG }, home: HOME,
      pyCandidates: ["/nowhere/host-agent.py", "/still-nowhere/host-agent.py"],
      randomHex: () => "x".repeat(48), sleep: async () => {},
    });
    const out = await svc.up();
    expect(out.kind).toBe("py-not-found");
    if (out.kind !== "py-not-found") return;
    expect(out.candidates).toEqual(["/nowhere/host-agent.py", "/still-nowhere/host-agent.py"]);
    expect(processes.spawns).toEqual([]);
  });

  test("spawn-failed: daemon dies immediately after spawn → surfaces log path + tail", async () => {
    const { svc, fs, processes } = build();
    // spawnDetached adds to alive; we then remove the pid before the
    // liveness check re-reads it.
    const origSpawn = processes.spawnDetached.bind(processes);
    processes.spawnDetached = async (argv, opts) => {
      const pid = await origSpawn(argv, opts);
      // Simulate daemon crash: not alive by the time the service re-checks.
      processes.alive.delete(pid);
      return pid;
    };
    fs.seed(`${AGENT_HOME}/log`, "Traceback (most recent call last):\n  File …\nOSError: port in use\n");
    const out = await svc.up();
    expect(out.kind).toBe("spawn-failed");
    if (out.kind !== "spawn-failed") return;
    expect(out.logPath).toBe(`${AGENT_HOME}/log`);
    expect(out.logTail).toContain("port in use");
  });
});

describe("HostAgentService.down", () => {
  test("running agent → kills pid, removes pid + token files", async () => {
    const { svc, fs, processes } = build();
    await svc.up();
    expect(processes.alive.size).toBe(1);
    const r = await svc.down();
    expect(r.killed).toBe(true);
    expect(r.pid).toBe(1000);
    expect(processes.kills).toEqual([1000]);
    expect(await fs.exists(`${AGENT_HOME}/pid`)).toBe(false);
    expect(await fs.exists(`${AGENT_HOME}/token`)).toBe(false);
  });

  test("no pid file → no-op, no throw", async () => {
    const { svc, fs, processes } = build();
    // No prior up. But token file might exist from earlier; verify still no throw.
    const r = await svc.down();
    expect(r.killed).toBe(false);
    expect(r.pid).toBeUndefined();
    expect(processes.kills).toEqual([]);
    expect(await fs.exists(`${AGENT_HOME}/token`)).toBe(false);
  });
});

describe("HostAgentService.status", () => {
  test("running → { running: true, pid, bind, port }", async () => {
    const { svc, fs, processes } = build();
    fs.seed(`${AGENT_HOME}/pid`, "42");
    processes.alive.add(42);
    const st = await svc.status();
    expect(st.running).toBe(true);
    expect(st.pid).toBe(42);
    expect(st.bind).toBe("192.168.64.1");
    expect(st.port).toBe("9280");
  });

  test("stale pid file (pid dead) → { running: false }", async () => {
    const { svc, fs } = build();
    fs.seed(`${AGENT_HOME}/pid`, "42");
    // 42 not in alive
    const st = await svc.status();
    expect(st.running).toBe(false);
    expect(st.pid).toBeUndefined();
  });

  test("no pid file → { running: false }", async () => {
    const { svc } = build();
    const st = await svc.status();
    expect(st.running).toBe(false);
  });
});

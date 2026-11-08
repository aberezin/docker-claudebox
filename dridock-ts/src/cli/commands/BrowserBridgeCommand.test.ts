import { test, expect, describe, afterEach } from "bun:test";
import { BrowserBridgeCommand } from "./BrowserBridgeCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryHostProcessManager } from "../../test/fakes/InMemoryHostProcessManager.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

/**
 * #52 — env for these tests lives HERE, not in process.env.
 *
 * The commands now read `ctx.env`, so seeding the real process env no longer
 * reaches them. Pointing makeCtx at `process.env` would have fixed the
 * failures in one line and reintroduced exactly the leak #51 removed: a var
 * set in the developer's shell silently changing test outcomes. Instead
 * `setEnv` writes into this record and the Context is built from it — the
 * 83 existing `setEnv(...)` call sites keep working verbatim, and the suite
 * stops depending on ambient environment entirely.
 */
const testEnv: Record<string, string | undefined> = {};

function makeCtx(fs: InMemoryFileSystem, cwd = "/repo"): {
  ctx: Context; stdout: StringWriter; stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver(testEnv), cwd, home: "/home/alan", binName: "dridock-ts", stdout, stderr },
  };
}

/** Command reads process.env for path/port overrides — snapshot + restore. */
const ENV_KEYS = ["XDG_CONFIG_HOME", "DRIDOCK_CHROME", "DRIDOCK_CDP_PORT", "DRIDOCK_CDP_BIND"] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) delete testEnv[k];
});
function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
  if (v === undefined) delete testEnv[k];
  else testEnv[k] = v;
}

describe("BrowserBridgeCommand — arg validation + project guard", () => {
  test("no subcommand → usage + rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({ git: new StubGitToplevel("/repo") }).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage: dridock-ts browser-bridge up|down");
  });

  test("invalid subcommand → usage + rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({ git: new StubGitToplevel("/repo") }).run(["restart"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("up|down");
  });

  test("no dridock project (config.yml absent) → rc 1 with bootstrap hint", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({ git: new StubGitToplevel("/repo") }).run(["up"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no dridock project here");
    expect(stderr.text()).toContain("bootstrap");
  });
});

describe("BrowserBridgeCommand.up — end-to-end wire (fake processes)", () => {
  test("valid project + Chrome present → rc 0, spawns Chrome+forwarder, prints CDP URL hint", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "");
    const processes = new InMemoryHostProcessManager();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"),
      processes,
      sleep: async () => {},
      randomHex: () => "abababab",
      cdpProbe: async () => true,
    }).run(["up"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toBe("");
    // Chrome + forwarder both spawned.
    expect(processes.spawns).toHaveLength(2);
    // User-facing hint mentions the URL + the correct binName.
    const out = stdout.text();
    expect(out).toContain("CDP bridge up");
    expect(out).toContain("DRIDOCK_HOST_CDP_URL=http://192.168.64.1:9223");
    expect(out).toContain("dridock-ts browser-bridge down");
  });

  test("Chrome missing → rc 1 stderr, no spawn", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    // Do NOT seed Chrome path.
    const processes = new InMemoryHostProcessManager();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
      cdpProbe: async () => true,
    }).run(["up"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("Chrome not found");
    expect(stderr.text()).toContain("DRIDOCK_CHROME");
    expect(processes.spawns).toEqual([]);
  });

  test("second `up` while already running → 'already running' notice, no re-spawn", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "");
    const processes = new InMemoryHostProcessManager();
    // First up.
    await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
    }).run(["up"], makeCtx(fs).ctx);
    expect(processes.spawns).toHaveLength(2);
    // Second up — bridge still alive.
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
      cdpProbe: async () => true,
    }).run(["up"], ctx);
    expect(rc).toBe(0);
    expect(processes.spawns).toHaveLength(2);   // no additional spawn
    expect(stdout.text()).toContain("CDP bridge already running");
  });
});

describe("BrowserBridgeCommand.down — end-to-end", () => {
  test("bridge running → kills pids, removes marker, rc 0 with 'down' notice", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "");
    const processes = new InMemoryHostProcessManager();
    // Bring it up first.
    await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
    }).run(["up"], makeCtx(fs).ctx);
    expect(processes.alive.size).toBe(2);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc12345/.cdp-url")).toBe(true);

    // Down.
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
    }).run(["down"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("CDP bridge down");
    expect(processes.alive.size).toBe(0);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc12345/.cdp-url")).toBe(false);
  });

  test("nothing to tear down → rc 0, idempotent", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    const processes = new InMemoryHostProcessManager();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
    }).run(["down"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("CDP bridge down");
    expect(processes.kills).toEqual([]);
  });
});

// #94: probe-failed must surface with the right remediation hint — down+up
// for the reuse case, chrome/forward log paths for the fresh-spawn case.
describe("BrowserBridgeCommand.up — probe-failed surfacing (#94)", () => {
  test("fresh spawn, probe never responds → rc 2, stderr names the port + the log paths", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "");
    const processes = new InMemoryHostProcessManager();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
      cdpProbe: async () => false,                // never succeeds
    }).run(["up"], ctx);
    expect(rc).toBe(2);
    expect(stdout.text()).toBe("");
    const err = stderr.text();
    expect(err).toContain("CDP bridge probe failed");
    expect(err).toContain("192.168.64.1:9223");
    expect(err).toContain("6 attempts");          // fresh = 6 attempts
    expect(err).toContain("chrome.log");          // points at the chrome log
    expect(err).toContain("forward.log");         // points at the forwarder log
    expect(err).not.toContain("down && dridock-ts browser-bridge up");  // NOT the reuse-case hint
    // Marker must NOT have been written.
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc12345/.cdp-url")).toBe(false);
  });

  test("reuse path, probe fails → rc 2, stderr names the 'down && up' recovery and alreadyRunning cause", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "");
    const processes = new InMemoryHostProcessManager();

    // First up with a working probe — establishes live pids.
    const okCtx = makeCtx(fs);
    const rc1 = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
      cdpProbe: async () => true,
    }).run(["up"], okCtx.ctx);
    expect(rc1).toBe(0);

    // Second up: pids still alive, but socket now dead — the exact case that
    // motivated this issue.
    const { ctx, stderr } = makeCtx(fs);
    const rc2 = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      sleep: async () => {}, randomHex: () => "abababab",
      cdpProbe: async () => false,
    }).run(["up"], ctx);
    expect(rc2).toBe(2);
    const err = stderr.text();
    expect(err).toContain("CDP bridge probe failed");
    expect(err).toContain("1 attempt");           // reuse path: single probe
    expect(err).toContain("pids are alive but the socket is dead");
    expect(err).toContain("dridock-ts browser-bridge down && dridock-ts browser-bridge up");
    expect(err).not.toContain("chrome.log");      // NOT the fresh-spawn hint
  });
});

// #93: `dridock browser-bridge status [--json]`. Per Arfy's pre-review:
// rc 0 in both states, no side effects, three states distinguishable.
describe("BrowserBridgeCommand.status — read-only snapshot (#93)", () => {
  const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  /** Build a FakeProcessProbe inline (same shape as PidLiveness's) so the
   *  command tests don't depend on the service test's helper. */
  function fakeProbe(cmdlines: Record<number, string>): import("../../services/PidLiveness.ts").ProcessProbe {
    const map = new Map<number, string>(Object.entries(cmdlines).map(([k, v]) => [Number(k), v]));
    return {
      isRunning: (pid) => map.has(pid),
      getCommandLine: (pid) => map.get(pid),
    };
  }

  test("down (no pidsfile) → rc 0, stdout state=down, nothing on stderr", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"),
      processes: new InMemoryHostProcessManager(),
      cdpProbe: async () => true,          // won't be called in down case
    }).run(["status"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("state: down");
    expect(stdout.text()).toContain("pidsFile: ");
    expect(stdout.text()).toContain("(absent)");
    expect(stdout.text()).not.toContain("recover with");   // no recovery hint when just down
  });

  test("up-and-responding → rc 0, stdout state matches, pids both 'alive, cmdline matches'", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed(CHROME_PATH, "");
    fs.seed("/home/alan/.config/dridock/cdp/pids", "1000 1001");
    const processes = new InMemoryHostProcessManager();
    processes.alive.add(1000);
    processes.alive.add(1001);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      cdpProbe: async () => true,
      processProbe: fakeProbe({
        1000: CHROME_PATH + " --remote-debugging-port=9222",
        1001: "python3 /home/alan/.config/dridock/cdp/forward.py",
      }),
    }).run(["status"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("state: up-and-responding");
    expect(out).toContain("pid[0]: 1000 alive, cmdline matches");
    expect(out).toContain("pid[1]: 1001 alive, cmdline matches");
    expect(out).not.toContain("recover with");
  });

  test("up-but-socket-dead (the #94 case) → rc 0, stdout state + down+up recovery hint", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed(CHROME_PATH, "");
    fs.seed("/home/alan/.config/dridock/cdp/pids", "1000 1001");
    const processes = new InMemoryHostProcessManager();
    processes.alive.add(1000);
    processes.alive.add(1001);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      cdpProbe: async () => false,       // pids ok, socket dead
      processProbe: fakeProbe({
        1000: CHROME_PATH,
        1001: "python3 /home/alan/.config/dridock/cdp/forward.py",
      }),
    }).run(["status"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("state: up-but-socket-dead");
    expect(out).toContain("recover with:");
    expect(out).toContain("dridock-ts browser-bridge down && dridock-ts browser-bridge up");
  });

  test("--json emits single-line JSON with state, pids, bind, port", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    fs.seed(CHROME_PATH, "");
    fs.seed("/home/alan/.config/dridock/cdp/pids", "1000 1001");
    const processes = new InMemoryHostProcessManager();
    processes.alive.add(1000);
    processes.alive.add(1001);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"), processes,
      cdpProbe: async () => true,
      processProbe: fakeProbe({
        1000: CHROME_PATH,
        1001: "python3 /home/alan/.config/dridock/cdp/forward.py",
      }),
    }).run(["status", "--json"], ctx);
    expect(rc).toBe(0);
    // Single-line JSON — strict parse, state key present.
    const payload = JSON.parse(stdout.text().trim());
    expect(payload.kind).toBe("up-and-responding");
    expect(payload.bind).toBe("192.168.64.1");
    expect(payload.port).toBe("9223");
    expect(payload.pids).toHaveLength(2);
    expect(payload.pids[0].pid).toBe(1000);
    expect(payload.pids[0].alive).toBe(true);
    expect(payload.pids[0].cmdlineMatches).toBe(true);
  });

  test("unknown flag → rc 1 on stderr (genuine failure is not the same as 'down')", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc12345\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new BrowserBridgeCommand({
      git: new StubGitToplevel("/repo"),
      processes: new InMemoryHostProcessManager(),
    }).run(["status", "--bogus"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("unexpected argument '--bogus'");
    expect(stderr.text()).toContain("--json");
  });
});

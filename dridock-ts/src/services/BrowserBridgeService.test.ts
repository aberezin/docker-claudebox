import { test, expect, describe } from "bun:test";
import { BrowserBridgeService, forwarderPython } from "./BrowserBridgeService.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { InMemoryHostProcessManager } from "../test/fakes/InMemoryHostProcessManager.ts";

/** Build a service with sensible test defaults — Chrome present, cdp home
 *  under a fake XDG dir, no real sleep, deterministic hash. */
function build(overrides: {
  env?: Record<string, string | undefined>;
  chromePresent?: boolean;
} = {}): {
  svc: BrowserBridgeService;
  fs: InMemoryFileSystem;
  processes: InMemoryHostProcessManager;
} {
  const fs = new InMemoryFileSystem();
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (overrides.chromePresent !== false) fs.seed(chromePath, "");
  const processes = new InMemoryHostProcessManager();
  const svc = new BrowserBridgeService({
    fs, processes,
    env: { XDG_CONFIG_HOME: "/home/alan/.config", ...overrides.env },
    home: "/home/alan",
    randomHex: (n) => "ab".repeat(n),   // deterministic 4-byte → "abababab"
    sleep: async () => { /* no real wait */ },
  });
  return { svc, fs, processes };
}

describe("BrowserBridgeService.up — first-time launch (cold start)", () => {
  test("spawns Chrome, spawns forwarder, writes pids + hash + marker", async () => {
    const { svc, fs, processes } = build();
    const outcome = await svc.up("abc12345");
    expect(outcome.kind).toBe("up");
    if (outcome.kind !== "up") return;
    expect(outcome.alreadyRunning).toBe(false);
    expect(outcome.windowTitle).toBe("Claudebox Chrome -- abababab");
    expect(outcome.url).toBe("http://192.168.64.1:9223");

    // Two spawns: Chrome first, then forwarder (order matters — the
    // sleep between them lets Chrome bind its port before the forwarder
    // tries to proxy).
    expect(processes.spawns).toHaveLength(2);
    expect(processes.spawns[0]!.argv[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(processes.spawns[0]!.argv).toContain("--remote-debugging-port=9222");
    expect(processes.spawns[0]!.argv).toContain("--user-data-dir=/home/alan/.config/dridock/cdp/chrome-debug-profile");
    expect(processes.spawns[0]!.argv).toContain("--remote-allow-origins=*");
    expect(processes.spawns[1]!.argv[0]).toBe("python3");
    expect(processes.spawns[1]!.argv[1]).toBe("/home/alan/.config/dridock/cdp/forward.py");

    // State written: pids, window-hash, per-project marker.
    expect((await fs.readText("/home/alan/.config/dridock/cdp/pids")).trim()).toBe("1000 1001");
    expect((await fs.readText("/home/alan/.config/dridock/cdp/window-hash")).trim()).toBe("abababab");
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc12345/.cdp-url")).toBe("http://192.168.64.1:9223");

    // forward.py rendered with the resolved bind+port.
    const fwd = await fs.readText("/home/alan/.config/dridock/cdp/forward.py");
    expect(fwd).toContain(`LISTEN=('192.168.64.1', 9223)`);
    expect(fwd).toContain(`DEST=('127.0.0.1', 9222)`);
  });

  test("Chrome not found → returns chrome-not-found (rc 1 at command layer), no spawn", async () => {
    const { svc, processes } = build({ chromePresent: false });
    const outcome = await svc.up("abc12345");
    expect(outcome.kind).toBe("chrome-not-found");
    if (outcome.kind !== "chrome-not-found") return;
    expect(outcome.chromePath).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(processes.spawns).toEqual([]);
  });

  test("DRIDOCK_CHROME env overrides Chrome path", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/opt/chromium/Chromium", "");
    const processes = new InMemoryHostProcessManager();
    const svc = new BrowserBridgeService({
      fs, processes,
      env: {
        XDG_CONFIG_HOME: "/home/alan/.config",
        DRIDOCK_CHROME: "/opt/chromium/Chromium",
      },
      home: "/home/alan",
      randomHex: () => "deadbeef",
      sleep: async () => {},
    });
    const outcome = await svc.up("abc12345");
    expect(outcome.kind).toBe("up");
    expect(processes.spawns[0]!.argv[0]).toBe("/opt/chromium/Chromium");
  });

  test("DRIDOCK_CDP_PORT / CHROME_PORT / BIND overrides applied to argv + marker + forward.py", async () => {
    const { svc, fs, processes } = build({
      env: {
        DRIDOCK_CDP_PORT: "19223",
        DRIDOCK_CDP_CHROME_PORT: "19222",
        DRIDOCK_CDP_BIND: "10.0.0.5",
      },
    });
    const outcome = await svc.up("abc12345");
    expect(outcome.kind).toBe("up");
    if (outcome.kind !== "up") return;
    expect(outcome.url).toBe("http://10.0.0.5:19223");
    expect(processes.spawns[0]!.argv).toContain("--remote-debugging-port=19222");
    const fwd = await fs.readText("/home/alan/.config/dridock/cdp/forward.py");
    expect(fwd).toContain(`LISTEN=('10.0.0.5', 19223)`);
    expect(fwd).toContain(`DEST=('127.0.0.1', 19222)`);
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc12345/.cdp-url"))
      .toBe("http://10.0.0.5:19223");
  });

  test("DRIDOCK_CDP_PROFILE relocates the Chrome user-data-dir", async () => {
    const { svc, processes } = build({
      env: { DRIDOCK_CDP_PROFILE: "/custom/chrome-profile" },
    });
    await svc.up("abc12345");
    expect(processes.spawns[0]!.argv).toContain("--user-data-dir=/custom/chrome-profile");
  });
});

describe("BrowserBridgeService.up — second `up` while running (reuse path)", () => {
  test("bridge alive → no spawn, hash preserved, marker refreshed", async () => {
    const { svc, fs, processes } = build();
    // First up — cold start.
    await svc.up("abc12345");
    expect(processes.spawns).toHaveLength(2);
    const firstHash = (await fs.readText("/home/alan/.config/dridock/cdp/window-hash")).trim();

    // Second up — bridge still alive (InMemoryHostProcessManager keeps
    // spawned pids in .alive by default). MUST reuse.
    const outcome2 = await svc.up("abc12345");
    expect(outcome2.kind).toBe("up");
    if (outcome2.kind !== "up") return;
    expect(outcome2.alreadyRunning).toBe(true);
    // No additional spawns.
    expect(processes.spawns).toHaveLength(2);
    // Hash unchanged (reuse).
    expect((await fs.readText("/home/alan/.config/dridock/cdp/window-hash")).trim()).toBe(firstHash);
    // Marker still written (idempotent refresh — env may have changed).
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc12345/.cdp-url")).toBe("http://192.168.64.1:9223");
  });

  test("prior pids DEAD (Mac reboot, Chrome closed) → fresh spawn AND fresh hash", async () => {
    const { svc, fs, processes } = build();
    // Simulate a prior session that died — seed pids + hash on disk, but
    // mark those pids as NOT alive.
    fs.seed("/home/alan/.config/dridock/cdp/pids", "500 501");
    fs.seed("/home/alan/.config/dridock/cdp/window-hash", "oldbeef1");
    // (default alive set is empty, so 500/501 are dead)

    const outcome = await svc.up("abc12345");
    expect(outcome.kind).toBe("up");
    if (outcome.kind !== "up") return;
    expect(outcome.alreadyRunning).toBe(false);
    // Fresh spawn.
    expect(processes.spawns).toHaveLength(2);
    // Fresh hash (from deterministic seed).
    expect((await fs.readText("/home/alan/.config/dridock/cdp/window-hash")).trim()).toBe("abababab");
    expect(outcome.windowTitle).toBe("Claudebox Chrome -- abababab");
  });
});

describe("BrowserBridgeService.down", () => {
  test("kills every pid, removes pids + hash + marker files", async () => {
    const { svc, fs, processes } = build();
    // Set up state: pretend a bridge is running.
    await svc.up("abc12345");
    expect(processes.alive.size).toBe(2);   // both spawned pids alive

    const result = await svc.down("abc12345");
    expect(result.pidsKilled.sort()).toEqual([1000, 1001]);
    expect(processes.kills.sort()).toEqual([1000, 1001]);
    expect(processes.alive.size).toBe(0);
    // State files gone.
    expect(await fs.exists("/home/alan/.config/dridock/cdp/pids")).toBe(false);
    expect(await fs.exists("/home/alan/.config/dridock/cdp/window-hash")).toBe(false);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc12345/.cdp-url")).toBe(false);
  });

  test("no state on disk → no-op (idempotent, no throw)", async () => {
    const { svc, processes } = build();
    const result = await svc.down("abc12345");
    expect(result.pidsKilled).toEqual([]);
    expect(processes.kills).toEqual([]);
  });

  test("marker only exists for THIS project; other project's marker untouched", async () => {
    const { svc, fs } = build();
    await svc.up("abc12345");
    // Simulate a second project also has a bridge marker on disk.
    fs.seed("/home/alan/.config/dridock/projects/other9999/.cdp-url", "http://x");
    await svc.down("abc12345");
    // The unrelated project's marker survives.
    expect(await fs.exists("/home/alan/.config/dridock/projects/other9999/.cdp-url")).toBe(true);
  });
});

describe("forwarderPython — the emitted Python script", () => {
  test("substitutes bind + listen-port + chrome-port into fixed template", () => {
    const src = forwarderPython("10.0.0.5", 19223, 19222);
    expect(src).toContain(`LISTEN=('10.0.0.5', 19223)`);
    expect(src).toContain(`DEST=('127.0.0.1', 19222)`);
    // Sanity: still self-contained; no other placeholders leak.
    expect(src).toContain(`import socket, threading`);
    expect(src).toContain(`s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)`);
    expect(src).not.toContain(`$`);
    expect(src).not.toContain(`{`);
  });
});

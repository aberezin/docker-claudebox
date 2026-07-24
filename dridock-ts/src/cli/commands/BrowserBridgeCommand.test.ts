import { test, expect, describe, afterEach } from "bun:test";
import { BrowserBridgeCommand } from "./BrowserBridgeCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryHostProcessManager } from "../../test/fakes/InMemoryHostProcessManager.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/repo"): {
  ctx: Context; stdout: StringWriter; stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock-ts", stdout, stderr },
  };
}

/** Command reads process.env for path/port overrides — snapshot + restore. */
const ENV_KEYS = ["XDG_CONFIG_HOME", "DRIDOCK_CHROME", "DRIDOCK_CDP_PORT", "DRIDOCK_CDP_BIND"] as const;
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

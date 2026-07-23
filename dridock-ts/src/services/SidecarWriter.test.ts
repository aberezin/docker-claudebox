import { test, expect, describe } from "bun:test";
import { SidecarWriter, CONTAINER_ROLES } from "./SidecarWriter.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

describe("SidecarWriter — role fan-out", () => {
  test("writeAllRoles writes to all three role paths + returns them", async () => {
    const fs = new InMemoryFileSystem();
    const w = new SidecarWriter(fs, "/data", "claude-_p");
    const paths = await w.writeAllRoles("auth", "TOKEN=abc\n");
    expect(paths).toEqual([
      "/data/.claude-_p-auth",
      "/data/.claude-_p_prog-auth",
      "/data/.claude-_p_cron-auth",
    ]);
    for (const p of paths) {
      expect(await fs.readText(p)).toBe("TOKEN=abc\n");
      expect(fs.modeOf(p)).toBe(0o600);
    }
  });

  test("writeOneRole targets a specific role only", async () => {
    const fs = new InMemoryFileSystem();
    const w = new SidecarWriter(fs, "/data", "claude-_p");
    const path = await w.writeOneRole("args", "_prog", "-p 'hi'");
    expect(path).toBe("/data/.claude-_p_prog-args");
    expect(await fs.readText(path)).toBe("-p 'hi'");
    // Other roles NOT written
    expect(await fs.exists("/data/.claude-_p-args")).toBe(false);
    expect(await fs.exists("/data/.claude-_p_cron-args")).toBe(false);
  });

  test("overwrites — a subsequent writeAllRoles replaces content", async () => {
    const fs = new InMemoryFileSystem();
    const w = new SidecarWriter(fs, "/data", "claude-_p");
    await w.writeAllRoles("auth", "first\n");
    await w.writeAllRoles("auth", "second\n");
    expect(await fs.readText("/data/.claude-_p_prog-auth")).toBe("second\n");
  });

  test("empty content is a first-class write (matches bash's cdp/hostagent 'off' sidecars)", async () => {
    const fs = new InMemoryFileSystem();
    const w = new SidecarWriter(fs, "/data", "claude-_p");
    await w.writeAllRoles("cdp", "");
    for (const suffix of CONTAINER_ROLES) {
      const path = `/data/.claude-_p${suffix}-cdp`;
      expect(await fs.readText(path)).toBe("");
      expect(fs.modeOf(path)).toBe(0o644);
    }
  });

  test("mode is per-kind: auth/secrets/env/hostagent/args 0o600, cdp/vmip/update 0o644", async () => {
    const fs = new InMemoryFileSystem();
    const w = new SidecarWriter(fs, "/data", "c");
    await w.writeAllRoles("auth", "x");
    await w.writeAllRoles("secrets", "x");
    await w.writeAllRoles("env", "x");
    await w.writeAllRoles("hostagent", "x");
    await w.writeAllRoles("cdp", "x");
    await w.writeAllRoles("vmip", "x");
    await w.writeAllRoles("update", "");
    await w.writeOneRole("args", "_prog", "x");
    expect(fs.modeOf("/data/.c-auth")).toBe(0o600);
    expect(fs.modeOf("/data/.c-secrets")).toBe(0o600);
    expect(fs.modeOf("/data/.c-env")).toBe(0o600);
    expect(fs.modeOf("/data/.c-hostagent")).toBe(0o600);
    expect(fs.modeOf("/data/.c_prog-args")).toBe(0o600);
    expect(fs.modeOf("/data/.c-cdp")).toBe(0o644);
    expect(fs.modeOf("/data/.c-vmip")).toBe(0o644);
    expect(fs.modeOf("/data/.c-update")).toBe(0o644);
  });

  test("pathFor is a pure name — no FS writes", async () => {
    const fs = new InMemoryFileSystem();
    const w = new SidecarWriter(fs, "/data", "claude-_p");
    expect(w.pathFor("auth", "_prog")).toBe("/data/.claude-_p_prog-auth");
    expect(w.pathFor("cdp", "")).toBe("/data/.claude-_p-cdp");
    // Nothing written
    expect(await fs.exists("/data/.claude-_p_prog-auth")).toBe(false);
  });
});

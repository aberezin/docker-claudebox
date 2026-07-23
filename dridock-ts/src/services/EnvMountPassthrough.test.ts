import { test, expect, describe } from "bun:test";
import { collectEnvPassthrough, collectMountPassthrough } from "./EnvMountPassthrough.ts";

describe("collectEnvPassthrough — DRIDOCK_ENV_ / CLAUDEBOX_ENV_ / CLAUDE_ENV_ prefixes", () => {
  test("strips DRIDOCK_ENV_ prefix, forwards to container as bare name", () => {
    const r = collectEnvPassthrough({
      DRIDOCK_ENV_MY_VAR: "hello",
      UNRELATED: "ignored",
    });
    expect(r.envAdditions).toEqual([{ key: "MY_VAR", value: "hello" }]);
    expect(r.sidecarContent).toBe("MY_VAR=hello\n");
  });

  test("legacy CLAUDEBOX_ENV_ prefix still honored (one deprecation cycle)", () => {
    const r = collectEnvPassthrough({ CLAUDEBOX_ENV_FOO: "bar" });
    expect(r.envAdditions).toEqual([{ key: "FOO", value: "bar" }]);
  });

  test("upstream CLAUDE_ENV_ prefix still honored", () => {
    const r = collectEnvPassthrough({ CLAUDE_ENV_X: "y" });
    expect(r.envAdditions).toEqual([{ key: "X", value: "y" }]);
  });

  test("multiple forwards → sorted stable order (deterministic docker inspect + sidecar diff)", () => {
    const r = collectEnvPassthrough({
      DRIDOCK_ENV_B: "2",
      DRIDOCK_ENV_A: "1",
      DRIDOCK_ENV_C: "3",
    });
    expect(r.envAdditions.map((e) => e.key)).toEqual(["A", "B", "C"]);
    expect(r.sidecarContent).toBe("A=1\nB=2\nC=3\n");
  });

  test("prefix with no name (bare `DRIDOCK_ENV_=x`) → skipped, not `''=x`", () => {
    const r = collectEnvPassthrough({ DRIDOCK_ENV_: "x" });
    expect(r.envAdditions).toEqual([]);
    expect(r.sidecarContent).toBe("");
  });

  test("empty env map → empty additions AND empty sidecar (bash's 'always write so stale doesn't linger')", () => {
    const r = collectEnvPassthrough({});
    expect(r.envAdditions).toEqual([]);
    expect(r.sidecarContent).toBe("");
  });

  test("undefined values → forwarded as empty string (matches bash's `${value:-}` treatment)", () => {
    const r = collectEnvPassthrough({ DRIDOCK_ENV_X: undefined });
    expect(r.envAdditions).toEqual([{ key: "X", value: "" }]);
  });

  test("values containing '=' preserved (whole-value forwarding — bash's IFS='=' read splits on FIRST =)", () => {
    const r = collectEnvPassthrough({ DRIDOCK_ENV_URL: "https://a.com/?k=v" });
    expect(r.envAdditions[0]!.value).toBe("https://a.com/?k=v");
  });
});

describe("collectMountPassthrough — DRIDOCK_MOUNT_ / CLAUDEBOX_MOUNT_ / CLAUDE_MOUNT_ prefixes", () => {
  test("bare-path form auto-mirrors host:host", () => {
    const r = collectMountPassthrough({ DRIDOCK_MOUNT_SCRATCH: "/opt/scratch" });
    expect(r.mountAdditions).toEqual([{ host: "/opt/scratch", container: "/opt/scratch" }]);
  });

  test("colon form uses host:container as-is", () => {
    const r = collectMountPassthrough({ DRIDOCK_MOUNT_DATA: "/host/data:/mnt/data" });
    expect(r.mountAdditions).toEqual([{ host: "/host/data", container: "/mnt/data" }]);
  });

  test("legacy CLAUDEBOX_MOUNT_ + upstream CLAUDE_MOUNT_ honored", () => {
    const r = collectMountPassthrough({
      CLAUDEBOX_MOUNT_A: "/a",
      CLAUDE_MOUNT_B: "/b:/bb",
    });
    expect(r.mountAdditions).toEqual([
      { host: "/a", container: "/a" },
      { host: "/b", container: "/bb" },
    ]);
  });

  test("empty value → skipped (nothing to mount)", () => {
    const r = collectMountPassthrough({ DRIDOCK_MOUNT_X: "" });
    expect(r.mountAdditions).toEqual([]);
  });

  test("multiple mounts sorted stable order for deterministic docker inspect", () => {
    const r = collectMountPassthrough({
      DRIDOCK_MOUNT_Z: "/z",
      DRIDOCK_MOUNT_A: "/a",
    });
    expect(r.mountAdditions.map((m) => m.host)).toEqual(["/a", "/z"]);
  });

  test("non-matching env vars ignored", () => {
    const r = collectMountPassthrough({ SOMETHING_ELSE: "/nope", HOME: "/home/alan" });
    expect(r.mountAdditions).toEqual([]);
  });
});

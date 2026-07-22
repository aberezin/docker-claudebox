import { test, expect, describe } from "bun:test";
import { sidecarFilename, sidecarFilenamesForAllRoles, SIDECAR_KINDS } from "./Sidecar.ts";

describe("sidecarFilename", () => {
  test("interactive role has no suffix between name and -kind", () => {
    expect(sidecarFilename("claude-abc", "", "auth")).toBe(".claude-abc-auth");
    expect(sidecarFilename("claude-abc", "", "secrets")).toBe(".claude-abc-secrets");
  });

  test("_prog role slots between name and -kind", () => {
    expect(sidecarFilename("claude-abc", "_prog", "auth")).toBe(".claude-abc_prog-auth");
    expect(sidecarFilename("claude-abc", "_prog", "env")).toBe(".claude-abc_prog-env");
  });

  test("_cron role same shape", () => {
    expect(sidecarFilename("claude-abc", "_cron", "auth")).toBe(".claude-abc_cron-auth");
  });

  test.each(Object.keys(SIDECAR_KINDS))("every SIDECAR_KIND '%s' produces a valid filename", (kind) => {
    const path = sidecarFilename("claude-x", "_prog", kind as any);
    expect(path).toStartWith(".claude-x_prog-");
    expect(path.length).toBeGreaterThan(".claude-x_prog-".length);
  });
});

describe("sidecarFilenamesForAllRoles", () => {
  test("returns all three roles keyed by role suffix", () => {
    const paths = sidecarFilenamesForAllRoles("claude-foo", "auth");
    expect(paths).toEqual({
      "": ".claude-foo-auth",
      "_prog": ".claude-foo_prog-auth",
      "_cron": ".claude-foo_cron-auth",
    });
  });
});

describe("SIDECAR_KINDS invariants", () => {
  test("credential-carrying kinds are mode 0o600", () => {
    // Kinds that DO carry credentials — must not leak via 644.
    expect(SIDECAR_KINDS.auth.mode).toBe(0o600);
    expect(SIDECAR_KINDS.secrets.mode).toBe(0o600);
    expect(SIDECAR_KINDS.env.mode).toBe(0o600);   // #30 — DRIDOCK_ENV_* may carry secrets
  });

  test("non-credential kinds are mode 0o644 (default readable)", () => {
    expect(SIDECAR_KINDS.cdp.mode).toBe(0o644);
    expect(SIDECAR_KINDS.vmip.mode).toBe(0o644);
    expect(SIDECAR_KINDS.hostagent.mode).toBe(0o644);
  });
});

describe("bash-compat regression pins (wrapper.sh writes these exact paths today)", () => {
  test("auth interactive: .claude-<pwd>-auth", () => {
    // Exact string wrapper.sh writes at line ~2710 (post 3.3.7).
    expect(sidecarFilename("claude-example", "", "auth")).toBe(".claude-example-auth");
  });
  test("auth prog: .claude-<pwd>_prog-auth", () => {
    expect(sidecarFilename("claude-example", "_prog", "auth")).toBe(".claude-example_prog-auth");
  });
  test("env prog: .claude-<pwd>_prog-env (3.3.0's -env sidecar)", () => {
    expect(sidecarFilename("claude-example", "_prog", "env")).toBe(".claude-example_prog-env");
  });
});

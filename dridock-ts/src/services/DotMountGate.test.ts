import { test, expect, describe } from "bun:test";
import { DotMountGate, DOT_MOUNT_MIN_IMAGE_VERSION } from "./DotMountGate.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";

const CTX = "colima-cb-abc";
const IMG = "dridock:latest";
function gate(version?: string): DotMountGate {
  const docker = new InMemoryDocker();
  if (version !== undefined) docker.seedImage(CTX, IMG, version);
  return new DotMountGate(docker, IMG);
}

describe("DotMountGate — the mount is gated on the IMAGE, never the host", () => {
  test(`image at the minimum → mount`, async () => {
    expect((await gate(DOT_MOUNT_MIN_IMAGE_VERSION).decide(CTX)).kind).toBe("mount");
  });

  test("image newer than the minimum → mount", async () => {
    expect((await gate("6.2.0").decide(CTX)).kind).toBe("mount");
  });

  test("image OLDER than the minimum → skip, because mounting would shadow the CLI", async () => {
    const d = await gate("5.0.0").decide(CTX);
    expect(d.kind).toBe("skip");
    // The reason must name the real consequence. "Skipped" alone sends someone
    // hunting for a config problem when the fix is `make build`.
    if (d.kind === "skip") {
      expect(d.reason).toContain("5.0.0");
      expect(d.note).toContain("would not start");
      expect(d.note).toContain("make build");
    }
  });

  test("no image at all → skip (cannot prove it is safe)", async () => {
    const d = await gate(undefined).decide(CTX);
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toContain("unavailable");
  });

  test("unstamped image (predates the version label) → skip", async () => {
    const d = await gate("unstamped").decide(CTX);
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toContain("unstamped");
  });

  test("garbage version → skip rather than throw", async () => {
    const d = await gate("not-a-version").decide(CTX);
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toContain("unparseable");
  });
});

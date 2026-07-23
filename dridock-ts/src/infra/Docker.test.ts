import { test, expect, describe } from "bun:test";
import { infraContext, projectProfile, projectContext, INFRA_PROFILE } from "./Docker.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";

describe("docker context / colima profile helpers — pure name formatting", () => {
  test("infraContext matches bash 'colima-cb-infra'", () => {
    expect(infraContext()).toBe("colima-cb-infra");
    expect(INFRA_PROFILE).toBe("cb-infra");
  });

  test("projectProfile prefixes 'cb-' onto the id (matches wrapper.sh:548)", () => {
    expect(projectProfile("abc12345")).toBe("cb-abc12345");
  });

  test("projectContext prefixes 'colima-cb-' onto the id (matches wrapper.sh:549)", () => {
    expect(projectContext("abc12345")).toBe("colima-cb-abc12345");
  });
});

describe("InMemoryDocker — P4a extensions", () => {
  test("imageIdentity: seed + read round-trips id + labels", async () => {
    const d = new InMemoryDocker();
    d.seedImageIdentity("colima-cb-infra", "dridock:latest", {
      id: "sha256:abc123",
      labels: { "org.dridock.version": "3.3.7" },
    });
    const identity = await d.imageIdentity("colima-cb-infra", "dridock:latest");
    expect(identity?.id).toBe("sha256:abc123");
    expect(identity?.labels["org.dridock.version"]).toBe("3.3.7");
    // absent → undefined
    expect(await d.imageIdentity("colima-cb-abc", "dridock:latest")).toBeUndefined();
  });

  test("containerIdentity: seed + read; containerRemove records + evicts", async () => {
    const d = new InMemoryDocker();
    d.seedContainer("colima-cb-abc", "claude-_p", { name: "claude-_p", imageId: "sha256:XYZ", status: "running" });
    expect((await d.containerIdentity("colima-cb-abc", "claude-_p"))?.imageId).toBe("sha256:XYZ");
    await d.containerRemove("colima-cb-abc", "claude-_p");
    expect(d.removals).toEqual([{ context: "colima-cb-abc", name: "claude-_p" }]);
    expect(await d.containerIdentity("colima-cb-abc", "claude-_p")).toBeUndefined();
    // Absent container: rm still records + doesn't throw
    await d.containerRemove("colima-cb-abc", "nonexistent");
    expect(d.removals).toHaveLength(2);
  });

  test("saveAndLoad: records the pipe + propagates identity + version to target on success", async () => {
    const d = new InMemoryDocker();
    d.seedImage("colima-cb-infra", "dridock:latest", "3.3.7");
    d.seedImageIdentity("colima-cb-infra", "dridock:latest", { id: "sha256:abc", labels: {} });
    const rc = await d.saveAndLoad("colima-cb-infra", "dridock:latest", "colima-cb-target");
    expect(rc).toBe(0);
    expect(d.saves).toEqual([{ source: "colima-cb-infra", image: "dridock:latest", target: "colima-cb-target" }]);
    // Target now has the same identity + version — models a real reseed's effect
    expect((await d.imageIdentity("colima-cb-target", "dridock:latest"))?.id).toBe("sha256:abc");
    expect(await d.imageVersion("colima-cb-target", "dridock:latest")).toBe("3.3.7");
  });

  test("saveAndLoad: nextSaveAndLoadRc override → nonzero, target NOT mutated", async () => {
    const d = new InMemoryDocker();
    d.seedImage("colima-cb-infra", "dridock:latest", "3.3.7");
    d.nextSaveAndLoadRc = 1;
    const rc = await d.saveAndLoad("colima-cb-infra", "dridock:latest", "colima-cb-target");
    expect(rc).toBe(1);
    expect(await d.imageVersion("colima-cb-target", "dridock:latest")).toBe("unavailable");
  });

  test("runCapture: seeded output returned; unseeded → rc 127 + empty stdout (matches shell 'command not found')", async () => {
    const d = new InMemoryDocker();
    d.seedRunCapture("dridock:latest", ["/usr/local/lib/dridock/features/typescript/manifest.yml"], 0, "description: TypeScript LSP\n");
    const seeded = await d.runCapture("colima-cb-abc", "dridock:latest", {
      entrypoint: "cat",
      args: ["/usr/local/lib/dridock/features/typescript/manifest.yml"],
    });
    expect(seeded).toEqual({ rc: 0, stdout: "description: TypeScript LSP\n" });
    // Call was recorded with args
    expect(d.runCalls[0]!.opts.entrypoint).toBe("cat");
    // Unseeded → default 127 (models 'no matching container ran')
    const unseeded = await d.runCapture(undefined, "dridock:latest", { args: ["nonsense"] });
    expect(unseeded).toEqual({ rc: 127, stdout: "" });
  });
});

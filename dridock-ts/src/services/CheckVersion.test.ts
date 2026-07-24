import { test, expect, describe } from "bun:test";
import { classify, CheckVersionService, type CheckVersionInputs } from "./CheckVersion.ts";
import { IMAGE_UNSTAMPED, IMAGE_UNAVAILABLE } from "../infra/Docker.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";

/**
 * Every branch of wrapper.sh:1122-1158 gets a fixture. classify() is pure —
 * no IO — so tests use the CheckVersionInputs record directly.
 */

function inp(overrides: Partial<CheckVersionInputs>): CheckVersionInputs {
  return {
    wrapperVersion: "3.3.7",
    infraImageVersion: "3.3.7",
    projectImageVersion: "3.3.7",
    projectId: "abc12345",
    ...overrides,
  };
}

describe("classify — in-sync", () => {
  test("all three match", () => {
    expect(classify(inp({}))).toEqual({ kind: "in-sync", version: "3.3.7" });
  });

  test("no project (bare dir) but cb-infra matches wrapper", () => {
    expect(classify(inp({ projectId: undefined, projectImageVersion: undefined })))
      .toEqual({ kind: "in-sync", version: "3.3.7" });
  });
});

describe("classify — reseed-needed", () => {
  test("cb-infra current, project VM behind", () => {
    const out = classify(inp({ projectImageVersion: "3.3.6" }));
    expect(out).toEqual({
      kind: "reseed-needed",
      wrapperVersion: "3.3.7",
      projectVersion: "3.3.6",
      infraVersion: "3.3.7",
    });
  });

  test("cb-infra current, project VM unstamped", () => {
    const out = classify(inp({ projectImageVersion: IMAGE_UNSTAMPED }));
    expect(out.kind).toBe("reseed-needed");
    if (out.kind === "reseed-needed") expect(out.projectVersion).toBe("unstamped");
  });
});

describe("classify — no-comparable", () => {
  test("both unstamped -> predates-versioning", () => {
    expect(classify(inp({ infraImageVersion: IMAGE_UNSTAMPED, projectImageVersion: IMAGE_UNSTAMPED })))
      .toEqual({ kind: "no-comparable", reason: "predates-versioning" });
  });

  test("both unavailable -> vms-down", () => {
    expect(classify(inp({ infraImageVersion: IMAGE_UNAVAILABLE, projectImageVersion: IMAGE_UNAVAILABLE })))
      .toEqual({ kind: "no-comparable", reason: "vms-down" });
  });

  test("no project + cb-infra unavailable -> vms-down", () => {
    expect(classify(inp({ projectId: undefined, projectImageVersion: undefined, infraImageVersion: IMAGE_UNAVAILABLE })))
      .toEqual({ kind: "no-comparable", reason: "vms-down" });
  });
});

describe("classify — drift", () => {
  test("wrapper newer, patch drift", () => {
    const out = classify({
      wrapperVersion: "3.3.8", infraImageVersion: "3.3.7", projectImageVersion: "3.3.7", projectId: "abc",
    });
    expect(out).toEqual({
      kind: "drift", wrapperVersion: "3.3.8", imageVersion: "3.3.7",
      severity: "patch", direction: "wrapper-newer",
    });
  });

  test("image newer, minor drift", () => {
    const out = classify({
      wrapperVersion: "3.3.0", infraImageVersion: "3.4.0", projectImageVersion: "3.4.0", projectId: "abc",
    });
    expect(out).toEqual({
      kind: "drift", wrapperVersion: "3.3.0", imageVersion: "3.4.0",
      severity: "minor", direction: "image-newer",
    });
  });

  test("major drift, wrapper newer", () => {
    const out = classify({
      wrapperVersion: "4.0.0", infraImageVersion: "3.3.7", projectImageVersion: "3.3.7", projectId: "abc",
    });
    expect(out).toMatchObject({ kind: "drift", severity: "major", direction: "wrapper-newer" });
  });

  test("drift comparison prefers project version over cb-infra when both present", () => {
    const out = classify({
      wrapperVersion: "3.4.0", infraImageVersion: "3.4.0", projectImageVersion: "3.3.7", projectId: "abc",
    });
    // reseed branch — cb-infra matches wrapper but project doesn't
    expect(out.kind).toBe("reseed-needed");
  });
});

describe("CheckVersionService — wires classify() to Docker", () => {
  test("evaluate() collects labels via the docker fake + returns classified outcome", async () => {
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc12345", "dridock:latest", "3.3.7");
    const svc = new CheckVersionService(docker, "dridock:latest");
    const r = await svc.evaluate("3.3.7", "abc12345");
    expect(r.infraImageVersion).toBe("3.3.7");
    expect(r.projectImageVersion).toBe("3.3.7");
    expect(r.outcome).toEqual({ kind: "in-sync", version: "3.3.7" });
  });

  test("no project id -> no project query, no project version", async () => {
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", "3.3.7");
    const svc = new CheckVersionService(docker, "dridock:latest");
    const r = await svc.evaluate("3.3.7", undefined);
    expect(r.projectImageVersion).toBeUndefined();
    expect(r.outcome).toEqual({ kind: "in-sync", version: "3.3.7" });
  });

  test("unavailable images survive to classify() as IMAGE_UNAVAILABLE", async () => {
    const docker = new InMemoryDocker(); // nothing seeded
    const svc = new CheckVersionService(docker, "dridock:latest");
    const r = await svc.evaluate("3.3.7", "abc");
    expect(r.infraImageVersion).toBe(IMAGE_UNAVAILABLE);
    expect(r.projectImageVersion).toBe(IMAGE_UNAVAILABLE);
    expect(r.outcome).toEqual({ kind: "no-comparable", reason: "vms-down" });
  });
});

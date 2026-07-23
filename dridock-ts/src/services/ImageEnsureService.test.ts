import { test, expect, describe } from "bun:test";
import { ImageEnsureService } from "./ImageEnsureService.ts";
import { InMemoryColima } from "../test/fakes/InMemoryColima.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";
import { infraContext } from "../infra/Docker.ts";

function build(): { svc: ImageEnsureService; colima: InMemoryColima; docker: InMemoryDocker } {
  const colima = new InMemoryColima();
  const docker = new InMemoryDocker();
  return {
    svc: new ImageEnsureService({ colima, docker, image: "dridock:latest" }),
    colima, docker,
  };
}

describe("ImageEnsureService.ensure — first-time seed", () => {
  test("target absent + cb-infra running with image → first-seed via saveAndLoad", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("first-seed");
    if (r.kind === "first-seed") expect(r.version).toBe("3.3.7");
    expect(docker.saves).toEqual([{ source: infraContext(), image: "dridock:latest", target: "colima-cb-abc" }]);
  });

  test("target absent + cb-infra NOT running → failed with reason", async () => {
    const { svc, docker } = build();
    // cb-infra is stopped/absent — ensureImage cannot proceed
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("not running");
  });

  test("target absent + cb-infra running but no image in cb-infra → failed", async () => {
    const { svc, colima } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    // No image seeded
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("not present");
  });
});

describe("ImageEnsureService.ensure — drift-reseed", () => {
  test("target current version = cb-infra version → already-current, no reseed", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    expect(docker.saves).toEqual([]); // no reseed
  });

  test("target OLDER than cb-infra → reseed via saveAndLoad", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.4.0");
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("reseeded");
    if (r.kind === "reseeded") {
      expect(r.from).toBe("3.3.7");
      expect(r.to).toBe("3.4.0");
    }
    expect(docker.saves).toEqual([{ source: infraContext(), image: "dridock:latest", target: "colima-cb-abc" }]);
  });

  test("target NEWER than cb-infra (weird — pinned or stale infra) → already-current, no downgrade", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.4.0");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    expect(docker.saves).toEqual([]);
  });

  test("cb-infra not running → skip drift check (never boot cb-infra just to check)", async () => {
    const { svc, docker } = build();
    // cb-infra NOT seeded/running
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    expect(docker.saves).toEqual([]);
  });

  test("target 'unstamped' + cb-infra current → reseed (unstamped is older than any real version)", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc", "dridock:latest", "unstamped");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("reseeded");
  });

  test("cb-infra unstamped → NO drift reseed (can't compare vs unstamped)", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "unstamped");
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    expect(docker.saves).toEqual([]);
  });
});

describe("ImageEnsureService.ensure — save|load failure", () => {
  test("saveAndLoad rc != 0 on first-seed → failed", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.nextSaveAndLoadRc = 1;
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("save|load rc 1");
  });
});

describe("ImageEnsureService.asCallback — the VmEnsureService adapter", () => {
  test("wraps success outcomes as ok:true", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    const cb = svc.asCallback();
    expect(await cb("colima-cb-abc")).toEqual({ ok: true });
  });

  test("wraps failed outcomes as ok:false + reason", async () => {
    const { svc } = build();
    const cb = svc.asCallback();
    const r = await cb("colima-cb-abc");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not running");
  });
});

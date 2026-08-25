import { test, expect, describe } from "bun:test";
import { ImageEnsureService } from "./ImageEnsureService.ts";
import { InMemoryColima } from "../test/fakes/InMemoryColima.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";
import { infraContext } from "../infra/Docker.ts";

function build(): {
  svc: ImageEnsureService; colima: InMemoryColima; docker: InMemoryDocker; notes: string[];
} {
  const colima = new InMemoryColima();
  const docker = new InMemoryDocker();
  const notes: string[] = [];
  return {
    svc: new ImageEnsureService({
      colima, docker, image: "dridock:latest",
      warn: (m) => { notes.push(m); },
    }),
    colima, docker, notes,
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

  test("cb-infra not running → unverified, NOT already-current (#76)", async () => {
    const { svc, docker } = build();
    // cb-infra NOT seeded/running
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    // Still never boots cb-infra just to check...
    expect(docker.saves).toEqual([]);
    // ...but "couldn't check" must not masquerade as "verified current".
    expect(r.kind).toBe("unverified");
    if (r.kind === "unverified") {
      expect(r.version).toBe("3.3.7");
      expect(r.reason).toContain("not running");
    }
  });

  test("target 'unstamped' + cb-infra current → reseed (unstamped is older than any real version)", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc", "dridock:latest", "unstamped");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("reseeded");
  });

  test("cb-infra unstamped → NO drift reseed, and unverified not already-current (#76)", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "unstamped");
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(docker.saves).toEqual([]);
    // cb-infra is UP but has nothing comparable, so the drift question is
    // still unanswered — same reporting rule as it being down.
    expect(r.kind).toBe("unverified");
    if (r.kind === "unverified") expect(r.reason).toContain("unstamped");
  });

  test("a genuinely verified current image stays already-current + emits no note", async () => {
    const { svc, colima, docker, notes } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    // The note must be specific to "couldn't check" — if it fired here too
    // it would be noise on every warm launch and get tuned out.
    await svc.asCallback()("colima-cb-abc");
    expect(notes).toEqual([]);
  });
});

describe("ImageEnsureService.asCallback — #76 drift note", () => {
  test("unverified still proceeds (ok) but emits a note naming the version and the fix", async () => {
    const { svc, docker, notes } = build();
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const out = await svc.asCallback()("colima-cb-abc");
    // Not a failure: the image works, the launch continues.
    expect(out.ok).toBe(true);
    expect(notes.length).toBe(1);
    // The note must say it did NOT check, name what's running, and give
    // the recovery command — a bare "may be behind" isn't actionable.
    expect(notes[0]).toContain("not checked");
    expect(notes[0]).toContain("3.3.7");
    expect(notes[0]).toContain("colima start -p cb-infra");
  });

  test("warn is optional — no sink means no crash", async () => {
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    const svc = new ImageEnsureService({ colima, docker, image: "dridock:latest" });
    const out = await svc.asCallback()("colima-cb-abc");
    expect(out.ok).toBe(true);
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

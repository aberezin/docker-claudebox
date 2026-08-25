import { test, expect, describe } from "bun:test";
import { ImageEnsureService, parseForceReseed, CLAUDE_CLI_LABEL } from "./ImageEnsureService.ts";
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


/* ── #78: a CLI-only rebuild must reach project VMs ──────────────────────── */

const V = "4.3.4";
/** Seed an image that is at harness version `V` and pins CLI `cli`. */
function seedWithCli(docker: InMemoryDocker, ctxName: string, cli?: string): void {
  docker.seedImage(ctxName, "dridock:latest", V);
  docker.seedImageIdentity(ctxName, "dridock:latest", {
    id: `sha256:${ctxName}`,
    labels: cli === undefined ? {} : { [CLAUDE_CLI_LABEL]: cli },
  });
}

describe("ImageEnsureService — claude CLI drift (#78)", () => {
  test("same harness semver but NEWER CLI in cb-infra → reseed", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    seedWithCli(docker, infraContext(), "2.1.243");
    seedWithCli(docker, "colima-cb-abc", "2.1.215");
    const r = await svc.ensure("colima-cb-abc");
    // This is the whole point: the semvers are EQUAL, so the pre-#78 code
    // returned already-current and the new CLI never propagated.
    expect(r.kind).toBe("reseeded");
    if (r.kind === "reseeded") expect(r.reason).toContain("2.1.215 → 2.1.243");
    expect(docker.saves.length).toBe(1);
  });

  test("a deliberate CLI DOWNGRADE in cb-infra also propagates", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    seedWithCli(docker, infraContext(), "2.1.215");
    seedWithCli(docker, "colima-cb-abc", "2.1.243");
    // cb-infra is the source of truth for what should be deployed. Pinning an
    // older CLI to dodge a regression is an explicit act and must reach the
    // project VMs, so this compares for DIFFERENCE, not newness.
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("reseeded");
    if (r.kind === "reseeded") expect(r.reason).toContain("2.1.243 → 2.1.215");
  });

  test("identical CLI → already-current, no save, no note", async () => {
    const { svc, colima, docker, notes } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    seedWithCli(docker, infraContext(), "2.1.243");
    seedWithCli(docker, "colima-cb-abc", "2.1.243");
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    expect(docker.saves).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("BOTH sides unstamped → silent already-current (the pre-#78 steady state)", async () => {
    const { svc, colima, docker, notes } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    seedWithCli(docker, infraContext(), undefined);
    seedWithCli(docker, "colima-cb-abc", undefined);
    const r = await svc.ensure("colima-cb-abc");
    // Nothing is knowable AND nothing changed — warning here would nag on
    // every launch of every existing install until an unrelated rebuild.
    expect(r.kind).toBe("already-current");
    expect(notes).toEqual([]);
    expect(docker.saves).toEqual([]);
  });

  test("exactly ONE side stamped → unverified, NOT a guessed reseed", async () => {
    for (const [infraCli, targetCli] of [["2.1.243", undefined], [undefined, "2.1.243"]] as const) {
      const { svc, colima, docker } = build();
      colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
      seedWithCli(docker, infraContext(), infraCli);
      seedWithCli(docker, "colima-cb-abc", targetCli);
      const r = await svc.ensure("colima-cb-abc");
      // Absent label means the image predates the stamp — that is "unknown",
      // not "matching". Reseeding on a guess would copy 7.5GB unprompted.
      expect(r.kind).toBe("unverified");
      if (r.kind === "unverified") expect(r.reason).toContain("predates");
      expect(docker.saves).toEqual([]);
    }
  });

  test("target on a NEWER harness semver is not downgraded over a CLI difference", async () => {
    const { svc, colima, docker } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage(infraContext(), "dridock:latest", "4.3.4");
    docker.seedImageIdentity(infraContext(), "dridock:latest", { id: "sha256:i", labels: { [CLAUDE_CLI_LABEL]: "2.1.243" } });
    docker.seedImage("colima-cb-abc", "dridock:latest", "4.4.0");
    docker.seedImageIdentity("colima-cb-abc", "dridock:latest", { id: "sha256:t", labels: { [CLAUDE_CLI_LABEL]: "2.1.215" } });
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("already-current");
    expect(docker.saves).toEqual([]);
  });
});

describe("ImageEnsureService — DRIDOCK_FORCE_RESEED (#78)", () => {
  test("force reseeds even when everything compares equal", async () => {
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    seedWithCli(docker, infraContext(), "2.1.243");
    seedWithCli(docker, "colima-cb-abc", "2.1.243");
    const svc = new ImageEnsureService({ colima, docker, image: "dridock:latest", force: true });
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("reseeded");
    if (r.kind === "reseeded") expect(r.reason).toContain("FORCE_RESEED");
    expect(docker.saves.length).toBe(1);
  });

  test("force rescues the un-comparable case — the reason it exists", async () => {
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    seedWithCli(docker, infraContext(), undefined);   // pre-stamp images
    seedWithCli(docker, "colima-cb-abc", undefined);
    const svc = new ImageEnsureService({ colima, docker, image: "dridock:latest", force: true });
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).toBe("reseeded");
  });

  test("force cannot invent an image cb-infra doesn't have", async () => {
    const colima = new InMemoryColima();
    const docker = new InMemoryDocker();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    docker.seedImage("colima-cb-abc", "dridock:latest", V);
    const svc = new ImageEnsureService({ colima, docker, image: "dridock:latest", force: true });
    const r = await svc.ensure("colima-cb-abc");
    expect(r.kind).not.toBe("reseeded");
    expect(docker.saves).toEqual([]);
  });

  test("parseForceReseed: accepted spellings, and an unrecognised value is REPORTED not swallowed", () => {
    for (const on of ["1", "true", "TRUE", "yes", " yes "]) expect(parseForceReseed(on)).toBe(true);
    for (const off of ["0", "false", "no", undefined, ""]) expect(parseForceReseed(off)).toBe(false);
    const seen: string[] = [];
    expect(parseForceReseed("please", (m) => seen.push(m))).toBe(false);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("not understood");
    // A recognised value must never produce noise.
    const quiet: string[] = [];
    parseForceReseed("1", (m) => quiet.push(m));
    expect(quiet).toEqual([]);
  });
});

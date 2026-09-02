import { test, expect, describe } from "bun:test";
import {
  teamSharedDir, partitionForReap, TEAM_SHARED_ROOT, TEAM_DIR_MODE,
} from "./TeamSharedDir.ts";

describe("teamSharedDir — deterministic, because a rendezvous must be discoverable", () => {
  test("same team name → same path, every time", () => {
    // The whole reason mktemp was rejected: the other account has to be
    // able to derive this path with no coordination.
    expect(teamSharedDir("dridock")).toBe(`${TEAM_SHARED_ROOT}/dridock`);
    expect(teamSharedDir("dridock")).toBe(teamSharedDir("dridock"));
  });

  test("different teams do not collide", () => {
    expect(teamSharedDir("dridock")).not.toBe(teamSharedDir("gammaray"));
  });

  test("DRIDOCK_TEAM_DIR override wins and is trimmed", () => {
    expect(teamSharedDir("dridock", "/srv/shared/x")).toBe("/srv/shared/x");
    expect(teamSharedDir("dridock", "  /srv/shared/x  ")).toBe("/srv/shared/x");
  });

  test("blank override falls back to the default rather than yielding ''", () => {
    expect(teamSharedDir("dridock", "   ")).toBe(`${TEAM_SHARED_ROOT}/dridock`);
  });

  // The name becomes a path segment, so traversal is the risk that matters.
  for (const bad of ["../etc", "a/b", "", ".hidden", "-lead", "x".repeat(65), "a b"]) {
    test(`rejects unsafe team name ${JSON.stringify(bad)}`, () => {
      expect(() => teamSharedDir(bad)).toThrow();
    });
  }

  test("the mode is sticky AND world-writable", () => {
    // World-writable so the other ACCOUNT can write; sticky so it cannot
    // delete our files. Dropping either breaks a different half.
    expect(TEAM_DIR_MODE & 0o1000).toBe(0o1000); // sticky
    expect(TEAM_DIR_MODE & 0o002).toBe(0o002);   // other-writable
  });
});

describe("partitionForReap — macOS will not clean /tmp for us", () => {
  const entries = [
    { name: "old.json", ageDays: 9 },
    { name: "fresh.json", ageDays: 0.2 },
    { name: "borderline.json", ageDays: 3 },
  ];

  test("reaps strictly older than the threshold, keeps the rest", () => {
    const { reap, keep } = partitionForReap(entries, 3);
    expect(reap.map((e) => e.name)).toEqual(["old.json"]);
    expect(keep.map((e) => e.name).sort()).toEqual(["borderline.json", "fresh.json"]);
  });

  test("exactly-at-threshold is KEPT, not reaped", () => {
    // Strict `>` is deliberate: the other member may be mid-write.
    expect(partitionForReap([{ name: "x", ageDays: 3 }], 3).reap).toHaveLength(0);
  });

  test("--older-than 0 reaps anything that has aged, not everything", () => {
    const { reap, keep } = partitionForReap(
      [{ name: "aged", ageDays: 0.001 }, { name: "just-now", ageDays: 0 }], 0,
    );
    expect(reap.map((e) => e.name)).toEqual(["aged"]);
    expect(keep.map((e) => e.name)).toEqual(["just-now"]);
  });

  test("nothing to reap → both lists coherent, no throw", () => {
    const { reap, keep } = partitionForReap([], 7);
    expect(reap).toHaveLength(0);
    expect(keep).toHaveLength(0);
  });

  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`rejects --older-than ${bad} rather than silently reaping`, () => {
      expect(() => partitionForReap(entries, bad)).toThrow("non-negative");
    });
  }
});

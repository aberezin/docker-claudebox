import { test, expect, describe } from "bun:test";
import { accumulateRc, isSkip, type MigrationReport } from "./MigrationReport.ts";

describe("isSkip — the audit-rule discriminant", () => {
  test("applied is not a skip", () => {
    expect(isSkip({ kind: "applied", from: "a", to: "b" })).toBe(false);
  });
  test("nothing-to-do is not a skip", () => {
    expect(isSkip({ kind: "nothing-to-do" })).toBe(false);
  });
  test("merged with 0 collisions is not a skip", () => {
    expect(isSkip({ kind: "merged", from: "a", to: "b", cleanCount: 3 })).toBe(false);
  });
  test("merged with >0 collisions IS a skip (needs human eyes)", () => {
    expect(isSkip({ kind: "merged", from: "a", to: "b", cleanCount: 2, collisionCount: 1 })).toBe(true);
  });
  test("skipped-conflict is a skip", () => {
    expect(isSkip({ kind: "skipped-conflict", reason: "split", hints: [] })).toBe(true);
  });
});

describe("accumulateRc — the migrate verb's exit code", () => {
  test("empty list → 0", () => {
    expect(accumulateRc([])).toBe(0);
  });
  test("all applied/nothing-to-do → 0", () => {
    const rs: MigrationReport[] = [
      { item: "workspace", outcome: { kind: "applied", from: "a", to: "b" } },
      { item: "machine-config", outcome: { kind: "nothing-to-do" } },
    ];
    expect(accumulateRc(rs)).toBe(0);
  });
  test("any skipped-conflict → 1 (matches wrapper.sh:2395 exit rc)", () => {
    const rs: MigrationReport[] = [
      { item: "workspace", outcome: { kind: "applied", from: "a", to: "b" } },
      { item: "state:cdp", outcome: { kind: "skipped-conflict", reason: "chrome running", hints: [] } },
    ];
    expect(accumulateRc(rs)).toBe(1);
  });
  test("merge with collisions → 1 (matches bash's split=1 in state-dirs)", () => {
    const rs: MigrationReport[] = [
      { item: "state:consult", outcome: { kind: "merged", from: "a", to: "b", cleanCount: 2, collisionCount: 1 } },
    ];
    expect(accumulateRc(rs)).toBe(1);
  });
});

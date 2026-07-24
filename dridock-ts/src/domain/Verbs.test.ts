import { test, expect, describe } from "bun:test";
import { VERBS, isKnownVerb, allVerbNames } from "./Verbs.ts";

describe("isKnownVerb", () => {
  test.each(["start", "info", "migrate", "consult", "framework-bugs", "browser-bridge"])(
    "'%s' is a known verb", (v) => { expect(isKnownVerb(v)).toBe(true); }
  );
  test.each(["chrome", "hello", "", "START", "info-x", "startt"])(
    "'%s' is NOT a known verb (matches wrapper.sh 3.3.7 rejection surface)", (v) => { expect(isKnownVerb(v)).toBe(false); }
  );
});

describe("allVerbNames — parity with wrapper.sh dispatch", () => {
  test("returns sorted, deduped list", () => {
    const names = allVerbNames();
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  // Regression pin: every verb wrapper.sh:2172-2757 handles must be in the
  // catalog. If someone adds a verb to bash but forgets TS, this fails.
  test.each([
    "start", "stop", "down", "destroy", "migrate", "bootstrap",
    "info", "status", "version", "checkversion",
    "features", "profiles", "vm",
    "browser-bridge", "host-agent", "harness",
    "framework-bugs", "consult", "claude-dir",
    "completion", "help",
    "setup-token", "clear-session", "doctor", "auth", "mcp",
    "report-bug", "df",
  ])("bash-dispatched verb '%s' is in the catalog", (v) => {
    expect(isKnownVerb(v)).toBe(true);
  });
});

describe("VerbSpec invariants", () => {
  test("every throwaway verb has needsProject=false (they run outside a project VM)", () => {
    for (const [name, spec] of Object.entries(VERBS)) {
      if (spec.class === "throwaway") {
        expect(spec.needsProject).toBe(false);
      }
    }
  });

  test("every launch verb has needsProject=true (they need the project VM)", () => {
    for (const [name, spec] of Object.entries(VERBS)) {
      if (spec.class === "launch") {
        expect(spec.needsProject).toBe(true);
      }
    }
  });

  test("subcommand lists are non-empty when declared (no accidental empty arrays)", () => {
    // Not enforcing sorted — some subcommand orders are meaningful (up before down).
    // TS narrows the tagged-union so aggressively that `spec.subcommands` isn't
    // even a valid access on non-subcommand variants; widen via VerbSpec cast.
    for (const [, spec] of Object.entries(VERBS) as [string, { subcommands?: readonly string[] }][]) {
      if (spec.subcommands !== undefined) {
        expect(spec.subcommands.length).toBeGreaterThan(0);
      }
    }
  });
});

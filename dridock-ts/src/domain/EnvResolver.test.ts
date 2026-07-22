import { test, expect, describe } from "bun:test";
import { EnvResolver } from "./EnvResolver.ts";
import { MissingEnvError } from "./errors.ts";

describe("EnvResolver.get — three-tier fallback", () => {
  test("prefers DRIDOCK_ over CLAUDEBOX_ over CLAUDE_", () => {
    const r = new EnvResolver({
      DRIDOCK_MODE_API_TOKEN: "dridock-wins",
      CLAUDEBOX_MODE_API_TOKEN: "claudebox-loses",
      CLAUDE_MODE_API_TOKEN: "claude-loses",
    });
    expect(r.get("MODE_API_TOKEN")).toBe("dridock-wins");
  });

  test("falls back to CLAUDEBOX_ when DRIDOCK_ is unset", () => {
    const r = new EnvResolver({
      CLAUDEBOX_MODE_API_TOKEN: "claudebox-wins",
      CLAUDE_MODE_API_TOKEN: "claude-loses",
    });
    expect(r.get("MODE_API_TOKEN")).toBe("claudebox-wins");
  });

  test("falls back to CLAUDE_ when neither DRIDOCK_ nor CLAUDEBOX_ is set", () => {
    const r = new EnvResolver({ CLAUDE_MODE_API_TOKEN: "claude-wins" });
    expect(r.get("MODE_API_TOKEN")).toBe("claude-wins");
  });

  test("returns undefined when no tier has it AND no default given", () => {
    const r = new EnvResolver({});
    expect(r.get("MODE_API_TOKEN")).toBeUndefined();
  });

  test("returns the provided default when no tier has it", () => {
    const r = new EnvResolver({});
    expect(r.get("MODE_API_TOKEN", "default-val")).toBe("default-val");
  });

  test("empty-string tier value is TREATED as set (falsy-value semantics from bash)", () => {
    // Matches wrapper.sh's `${DRIDOCK_X:-…}` where a set-but-empty var counts
    // as unset for :- purposes. Except — JS `??` treats "" as SET. Documenting
    // the divergence: our TS EnvResolver treats "" as SET on the DRIDOCK_ tier,
    // which is a behavior change vs bash's `:-`. Callers who need bash semantics
    // should filter empties: `r.get('X')?.trim() || undefined`. This is
    // intentional — the bash `:-` behavior masked a class of "someone exported
    // X=" bugs where the empty value should have been meaningful.
    const r = new EnvResolver({ DRIDOCK_X: "", CLAUDEBOX_X: "legacy" });
    expect(r.get("X")).toBe("");
  });
});

describe("EnvResolver.require — throws when missing", () => {
  test("returns the value when set", () => {
    const r = new EnvResolver({ DRIDOCK_MODE_API_TOKEN: "t" });
    expect(r.require("MODE_API_TOKEN")).toBe("t");
  });

  test("throws MissingEnvError when unset on every tier", () => {
    const r = new EnvResolver({});
    expect(() => r.require("MODE_API_TOKEN")).toThrow(MissingEnvError);
  });

  test("MissingEnvError has exitCode 2 (environment problem, not user error)", () => {
    const r = new EnvResolver({});
    try {
      r.require("MODE_API_TOKEN");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingEnvError);
      expect((e as MissingEnvError).exitCode).toBe(2);
    }
  });

  test("throws on empty-string DRIDOCK_ tier (treats '' as absent for `require`, matching bash's `:?` semantics)", () => {
    const r = new EnvResolver({ DRIDOCK_MODE_API_TOKEN: "" });
    expect(() => r.require("MODE_API_TOKEN")).toThrow(MissingEnvError);
  });
});

describe("EnvResolver.bool — bash `case ... in 1|true|yes|on)` idiom", () => {
  test.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["on", true],
    ["TRUE", true],  // case-insensitive
    ["ON", true],
    ["Yes", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["off", false],
    ["", false],
    ["random-string", false],
  ])("DRIDOCK_FEATURE=%s → %s", (val, expected) => {
    const r = new EnvResolver({ DRIDOCK_FEATURE: val });
    expect(r.bool("FEATURE")).toBe(expected);
  });

  test("unset var → false", () => {
    const r = new EnvResolver({});
    expect(r.bool("FEATURE")).toBe(false);
  });

  test("respects the same three-tier fallback as `get`", () => {
    const r = new EnvResolver({ CLAUDEBOX_FEATURE: "1" });
    expect(r.bool("FEATURE")).toBe(true);
  });
});

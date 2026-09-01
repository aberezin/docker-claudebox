import { test, expect, describe } from "bun:test";
import { EnvResolver } from "./EnvResolver.ts";
import { MissingEnvError } from "./errors.ts";

describe("EnvResolver.get — single DRIDOCK_ tier (5.0.0)", () => {
  test("reads DRIDOCK_ and ignores the removed legacy tiers", () => {
    const r = new EnvResolver({
      DRIDOCK_MODE_API_TOKEN: "dridock-wins",
      CLAUDEBOX_MODE_API_TOKEN: "claudebox-loses",
      CLAUDE_MODE_API_TOKEN: "claude-loses",
    });
    expect(r.get("MODE_API_TOKEN")).toBe("dridock-wins");
  });

  test("legacy CLAUDEBOX_ is IGNORED (tier removed in 5.0.0)", () => {
    const r = new EnvResolver({
      CLAUDEBOX_MODE_API_TOKEN: "legacy-ignored",
      CLAUDE_MODE_API_TOKEN: "legacy-ignored-too",
    });
    // Deliberately undefined, not a fallback. Through 4.x these silently won,
    // which is what made a green suite unable to prove the documented name
    // worked (#82). See docs/roadmap.md.
    expect(r.get("MODE_API_TOKEN")).toBeUndefined();
  });

  test("a default still applies when only legacy names are set", () => {
    const r = new EnvResolver({ CLAUDEBOX_MODE_API_PORT: "9999" });
    // The legacy value must not leak in ahead of the default either.
    expect(r.get("MODE_API_PORT", "8080")).toBe("8080");
  });

  test("DRIDOCK_ wins and is the only tier consulted", () => {
    const r = new EnvResolver({
      DRIDOCK_MODE_API_TOKEN: "canonical",
      CLAUDEBOX_MODE_API_TOKEN: "legacy",
      CLAUDE_MODE_API_TOKEN: "older",
    });
    expect(r.get("MODE_API_TOKEN")).toBe("canonical");
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

  test("bool reads the same single tier as `get`", () => {
    expect(new EnvResolver({ DRIDOCK_MINIMAL: "1" }).bool("MINIMAL")).toBe(true);
    // Legacy name set, canonical absent -> false, not true.
    expect(new EnvResolver({ CLAUDEBOX_MINIMAL: "1" }).bool("MINIMAL")).toBe(false);
  });
});

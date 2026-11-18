import { test, expect, describe } from "bun:test";
import { parseDebugValue, resolveDebug, debugEnvPairs } from "./DebugFlag.ts";

describe("#130 DRIDOCK_DEBUG", () => {
  test.each(["1", "true", "TRUE", "Yes", "on", " true "])("'%s' is on", (v) => expect(parseDebugValue(v)).toBe("on"));
  test.each(["", "0", "false", "No", "OFF"])("'%s' is off", (v) => expect(parseDebugValue(v)).toBe("off"));
  test.each(["2", "maybe", "express:*", "tru"])("'%s' is invalid", (v) => expect(parseDebugValue(v)).toBe("invalid"));

  test("DRIDOCK_DEBUG wins, quietly", () => {
    const r = resolveDebug({ DRIDOCK_DEBUG: "1", DEBUG: "false" });
    expect(r).toEqual({ on: true, notes: [] });
  });
  test("an unrecognised DRIDOCK_DEBUG is off, and SAID (the #31 class)", () => {
    const r = resolveDebug({ DRIDOCK_DEBUG: "verbose" });
    expect(r.on).toBe(false);
    expect(r.notes.join("")).toContain("DRIDOCK_DEBUG=verbose isn't a recognised value");
  });
  test("legacy DEBUG=1 (was dropped by the host) is honoured, with the rename nudge", () => {
    const r = resolveDebug({ DEBUG: "1" });
    expect(r.on).toBe(true);
    expect(r.notes.join("")).toContain("bare DEBUG stops working in 7.0.0. Use DRIDOCK_DEBUG=1");
  });
  test("legacy DEBUG=TRUE (case) is honoured", () => expect(resolveDebug({ DEBUG: "TRUE" }).on).toBe(true));
  test("npm's DEBUG=express:* is someone else's: off, and nothing said", () => {
    expect(resolveDebug({ DEBUG: "express:*" })).toEqual({ on: false, notes: [] });
  });
  test("nothing set → off, nothing said", () => expect(resolveDebug({})).toEqual({ on: false, notes: [] }));
  test("forwarded as both names, so a pre-6.1 image still honours it", () => {
    expect(debugEnvPairs(true)).toEqual([{ key: "DRIDOCK_DEBUG", value: "1" }, { key: "DEBUG", value: "true" }]);
    expect(debugEnvPairs(false)).toEqual([]);
  });
});

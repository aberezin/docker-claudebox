import { test, expect, describe } from "bun:test";
import { Version, type Severity } from "./Version.ts";
import { DridockError } from "./errors.ts";

describe("Version.parse", () => {
  test("plain MAJOR.MINOR.PATCH", () => {
    const v = Version.parse("3.3.7");
    expect(v.major).toBe(3);
    expect(v.minor).toBe(3);
    expect(v.patch).toBe(7);
    expect(v.raw).toBe("3.3.7");
  });

  test("tolerates leading 'v' (git tag format)", () => {
    const v = Version.parse("v3.3.7");
    expect(v.toString()).toBe("3.3.7");
    expect(v.raw).toBe("v3.3.7");   // raw preserves input for messages
  });

  test("tolerates trailing whitespace/newline (VERSION file)", () => {
    const v = Version.parse("3.3.7\n");
    expect(v.toString()).toBe("3.3.7");
  });

  test.each([
    "3.3", "3.3.7.1", "three.three.seven", "-1.0.0", "3.3.7-rc1", "3.3.7+meta", "",
  ])("rejects malformed input: %s", (input) => {
    expect(() => Version.parse(input)).toThrow(DridockError);
  });
});

describe("Version.compareTo", () => {
  test.each<[string, string, -1 | 0 | 1]>([
    ["3.3.7", "3.3.7", 0],
    ["3.3.6", "3.3.7", -1],
    ["3.3.8", "3.3.7", 1],
    ["3.2.99", "3.3.0", -1],   // minor beats patch
    ["2.99.99", "3.0.0", -1],  // major beats minor
    ["10.0.0", "9.99.99", 1],  // numeric, not lexical (bash sort -V pitfall)
  ])("(%s).compareTo(%s) === %s", (a, b, expected) => {
    expect(Version.parse(a).compareTo(Version.parse(b))).toBe(expected);
  });
});

describe("Version.skewSeverity", () => {
  test.each<[string, string, Severity]>([
    ["3.3.7", "3.3.7", "same"],
    ["3.3.6", "3.3.7", "patch"],
    ["3.3.7", "3.3.6", "patch"],
    ["3.2.0", "3.3.7", "minor"],
    ["3.3.0", "4.0.0", "major"],
    ["4.0.0", "3.3.0", "major"],
  ])("skewSeverity(%s, %s) === %s", (a, b, sev) => {
    expect(Version.skewSeverity(Version.parse(a), Version.parse(b))).toBe(sev);
  });
});

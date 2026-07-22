import { test, expect, describe } from "bun:test";
import { cbNum, cbH } from "./units.ts";
import { DridockError } from "./errors.ts";

describe("cbNum — parity with wrapper.sh's cb_num", () => {
  // These are the exact cases wrapper.sh's cb_num handled + tests/test_cbvm.sh's assertions.
  test.each<[string, number]>([
    ["8GiB", 8],
    ["60GiB", 60],
    ["100GiB", 100],
    ["4GiB", 4],
    ["1.5TiB", 1.5],
    ["512", 512],
  ])("cbNum('%s') === %s", (input, expected) => {
    expect(cbNum(input)).toBe(expected);
  });

  test("tolerates leading whitespace", () => {
    expect(cbNum("  8GiB")).toBe(8);
  });

  test("throws on unparseable input (was silent empty in bash)", () => {
    expect(() => cbNum("GiB")).toThrow(DridockError);
    expect(() => cbNum("")).toThrow(DridockError);
    expect(() => cbNum("abc")).toThrow(DridockError);
  });
});

describe("cbH — parity with wrapper.sh's cb_h", () => {
  // Exact cases from tests/test_cbvm.sh's cb_h assertion block.
  test.each<[number | undefined, string]>([
    [0, "0B"],
    [undefined, "0B"],
    [512, "512B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [1073741824, "1 GiB"],
    [8 * 1073741824, "8 GiB"],
  ])("cbH(%s) === '%s'", (bytes, expected) => {
    expect(cbH(bytes)).toBe(expected);
  });

  test("rejects negative bytes (bash silently returned garbage)", () => {
    expect(() => cbH(-1)).toThrow(DridockError);
  });

  test("handles values up to Number.MAX_SAFE_INTEGER without overflow", () => {
    // Bash's arithmetic silently overflowed on `((huge * 1024))`; JS is safe.
    expect(cbH(1024 ** 5)).toBe("1 PiB");
  });
});

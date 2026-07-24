import { test, expect, describe } from "bun:test";
import { decideVmLimit } from "./VmLimits.ts";

describe("decideVmLimit — the count guardrail (bash cb_vm_limit_decision)", () => {
  test("below warn → ok", () => expect(decideVmLimit(0, 3, 5)).toBe("ok"));
  test("at warn → warn", () => expect(decideVmLimit(3, 3, 5)).toBe("warn"));
  test("between warn and hard → warn", () => expect(decideVmLimit(4, 3, 5)).toBe("warn"));
  test("at hard → deny", () => expect(decideVmLimit(5, 3, 5)).toBe("deny"));
  test("above hard → deny", () => expect(decideVmLimit(10, 3, 5)).toBe("deny"));
  test("non-numeric inputs (NaN) → ok (matches bash `[!0-9]*` guard)", () => {
    expect(decideVmLimit(NaN, 3, 5)).toBe("ok");
    expect(decideVmLimit(3, NaN, 5)).toBe("ok");
    expect(decideVmLimit(3, 3, NaN)).toBe("ok");
  });
});

import { test, expect, describe } from "bun:test";
import { Ok, Err, isOk, isErr, type Result } from "./Result.ts";

describe("Result", () => {
  test("Ok carries value + narrows to { ok:true }", () => {
    const r: Result<number, string> = Ok(42);
    expect(r.ok).toBe(true);
    if (isOk(r)) expect(r.value).toBe(42);
    expect(isErr(r)).toBe(false);
  });

  test("Err carries error + narrows to { ok:false }", () => {
    const r: Result<number, string> = Err("nope");
    expect(r.ok).toBe(false);
    if (isErr(r)) expect(r.error).toBe("nope");
    expect(isOk(r)).toBe(false);
  });
});

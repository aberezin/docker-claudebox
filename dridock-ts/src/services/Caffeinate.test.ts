import { test, expect, describe } from "bun:test";
import { caffeinateRequested, maybeCaffeinate, type KeepAwake } from "./Caffeinate.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import { StringWriter } from "../cli/Context.ts";

class FakeKeepAwake implements KeepAwake {
  holds: number[] = [];
  constructor(private readonly present: boolean) {}
  available(): boolean { return this.present; }
  hold(pid: number): void { this.holds.push(pid); }
}

describe("DRIDOCK_CAFFEINATE (#110)", () => {
  test("on/off rule matches 3.x: empty/0/false/no/off are off, anything else on", () => {
    for (const v of [undefined, "", "0", "false", "NO", "off", " "]) {
      expect(caffeinateRequested(new EnvResolver(v === undefined ? {} : { DRIDOCK_CAFFEINATE: v }))).toBe(false);
    }
    for (const v of ["1", "true", "yes", "on", "2"]) {
      expect(caffeinateRequested(new EnvResolver({ DRIDOCK_CAFFEINATE: v }))).toBe(true);
    }
  });

  test("requested + available → holds THIS pid, says nothing", () => {
    const k = new FakeKeepAwake(true);
    const err = new StringWriter();
    expect(maybeCaffeinate(new EnvResolver({ DRIDOCK_CAFFEINATE: "1" }), k, 4242, err)).toBe(true);
    expect(k.holds).toEqual([4242]);
    expect(err.text()).toBe("");
  });

  test("requested but no caffeinate binary → loud stderr, no hold", () => {
    const k = new FakeKeepAwake(false);
    const err = new StringWriter();
    expect(maybeCaffeinate(new EnvResolver({ DRIDOCK_CAFFEINATE: "1" }), k, 4242, err)).toBe(false);
    expect(k.holds).toEqual([]);
    expect(err.text()).toContain("nothing is keeping this machine awake");
  });

  test("not requested → no hold, no output", () => {
    const k = new FakeKeepAwake(true);
    const err = new StringWriter();
    expect(maybeCaffeinate(new EnvResolver({}), k, 4242, err)).toBe(false);
    expect(k.holds).toEqual([]);
    expect(err.text()).toBe("");
  });
});

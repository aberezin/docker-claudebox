import { test, expect, describe } from "bun:test";
import { parseColimaListJson } from "./Colima.ts";
import { InMemoryColima, StubPinger } from "../test/fakes/InMemoryColima.ts";

describe("parseColimaListJson", () => {
  test("parses JSONL output (one VM per line)", () => {
    const text = [
      '{"name":"cb-abc","status":"Running","address":"192.168.64.13","cpu":4,"memory":"8GiB","disk":"60GiB"}',
      '{"name":"cb-def","status":"Stopped","address":""}',
    ].join("\n");
    expect(parseColimaListJson(text)).toEqual([
      { name: "cb-abc", status: "Running", address: "192.168.64.13", cpu: 4, memory: "8GiB", disk: "60GiB" },
      { name: "cb-def", status: "Stopped", address: "", cpu: undefined, memory: undefined, disk: undefined },
    ]);
  });

  test("empty input → []", () => {
    expect(parseColimaListJson("")).toEqual([]);
    expect(parseColimaListJson("\n\n")).toEqual([]);
  });

  test("skips malformed lines silently (bash-parity)", () => {
    const text = [
      '{"name":"cb-abc","status":"Running","address":"1.2.3.4"}',
      "not json at all",
      '{"name":"cb-def","status":"Running","address":"5.6.7.8"}',
    ].join("\n");
    expect(parseColimaListJson(text).map((v) => v.name)).toEqual(["cb-abc", "cb-def"]);
  });

  test("skips objects with no name", () => {
    expect(parseColimaListJson('{"status":"Running","address":"1.1.1.1"}')).toEqual([]);
  });
});

describe("InMemoryColima — fake behaviors match Real semantics", () => {
  test("isRunning reflects seeded status", async () => {
    const c = new InMemoryColima();
    c.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    c.seedVm({ name: "cb-def", status: "Stopped", address: "" });
    expect(await c.isRunning("cb-abc")).toBe(true);
    expect(await c.isRunning("cb-def")).toBe(false);
    expect(await c.isRunning("cb-nonexistent")).toBe(false);
  });

  test("stop records + mutates status to Stopped, empties address", async () => {
    const c = new InMemoryColima();
    c.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    await c.stop("cb-abc");
    expect(c.stops).toEqual(["cb-abc"]);
    expect(await c.isRunning("cb-abc")).toBe(false);
    const after = await c.get("cb-abc");
    expect(after?.address).toBe("");
  });

  test("delete records + removes VM (idempotent when absent)", async () => {
    const c = new InMemoryColima();
    c.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    await c.delete("cb-abc");
    await c.delete("cb-abc"); // no throw
    await c.delete("cb-never-existed"); // no throw
    expect(c.deletions).toEqual(["cb-abc", "cb-abc", "cb-never-existed"]);
    expect(await c.get("cb-abc")).toBeUndefined();
  });
});

describe("InMemoryColima.start (P4a)", () => {
  test("start records the profile + opts + marks VM Running + assigns address when networkAddress: true", async () => {
    const c = new InMemoryColima();
    const rc = await c.start("cb-abc", { cpu: 4, memoryGiB: 8, diskGiB: 60, networkAddress: true });
    expect(rc).toBe(0);
    expect(c.starts).toEqual([{ profile: "cb-abc", opts: { cpu: 4, memoryGiB: 8, diskGiB: 60, networkAddress: true } }]);
    const vm = await c.get("cb-abc");
    expect(vm?.status).toBe("Running");
    expect(vm?.address).toBe("192.168.64.100");
    expect(vm?.cpu).toBe(4);
    expect(vm?.memory).toBe("8GiB");
    expect(vm?.disk).toBe("60GiB");
  });

  test("start with networkAddress: false → no address (matches cb-infra shape)", async () => {
    const c = new InMemoryColima();
    await c.start("cb-infra", { cpu: 2, memoryGiB: 4, diskGiB: 40, networkAddress: false });
    expect((await c.get("cb-infra"))?.address).toBe("");
  });

  test("nextStartRc override → nonzero rc, VM state NOT mutated", async () => {
    const c = new InMemoryColima();
    c.nextStartRc = 1;
    const rc = await c.start("cb-abc", { cpu: 4, memoryGiB: 8, diskGiB: 60, networkAddress: true });
    expect(rc).toBe(1);
    expect(await c.get("cb-abc")).toBeUndefined();
    // But the call was still recorded — for assertion of "we tried"
    expect(c.starts).toHaveLength(1);
  });

  test("extraMounts recorded in opts", async () => {
    const c = new InMemoryColima();
    await c.start("cb-abc", { cpu: 4, memoryGiB: 8, diskGiB: 60, networkAddress: true, extraMounts: ["/scratch:w"] });
    expect(c.starts[0]!.opts.extraMounts).toEqual(["/scratch:w"]);
  });
});

describe("InMemoryColima.waitReachable (P4a)", () => {
  test("returns the seeded address instantly when nextWaitReachableSuccess=true", async () => {
    const c = new InMemoryColima();
    c.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    expect(await c.waitReachable("cb-abc")).toBe("1.2.3.4");
  });

  test("returns undefined when nextWaitReachableSuccess=false (simulates timeout)", async () => {
    const c = new InMemoryColima();
    c.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    c.nextWaitReachableSuccess = false;
    expect(await c.waitReachable("cb-abc")).toBeUndefined();
  });

  test("returns undefined when the VM has no address (freshly started, col0 not yet up)", async () => {
    const c = new InMemoryColima();
    c.seedVm({ name: "cb-abc", status: "Running", address: "" });
    expect(await c.waitReachable("cb-abc")).toBeUndefined();
  });

  test("returns undefined when the profile is absent", async () => {
    const c = new InMemoryColima();
    expect(await c.waitReachable("cb-nonexistent")).toBeUndefined();
  });
});

describe("StubPinger (P4a)", () => {
  test("returns seeded outcome; unseeded hosts default false", async () => {
    const p = new StubPinger();
    p.seedReachable("1.2.3.4", true);
    p.seedReachable("5.6.7.8", false);
    expect(await p.reachable("1.2.3.4", 100)).toBe(true);
    expect(await p.reachable("5.6.7.8", 100)).toBe(false);
    expect(await p.reachable("9.9.9.9", 100)).toBe(false);
  });
});

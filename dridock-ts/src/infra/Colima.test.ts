import { test, expect, describe } from "bun:test";
import { parseColimaListJson } from "./Colima.ts";
import { InMemoryColima } from "../test/fakes/InMemoryColima.ts";

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

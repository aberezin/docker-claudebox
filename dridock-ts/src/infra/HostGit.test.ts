import { test, expect, describe } from "bun:test";
import { StubHostGit } from "../test/fakes/StubHostGit.ts";

describe("StubHostGit", () => {
  test("returns seeded value; unseeded → undefined (not empty string)", async () => {
    const g = new StubHostGit();
    g.seedConfig("user.name", "Alan Berezin");
    g.seedConfig("user.email", "alan@example.com");
    expect(await g.configGet("user.name")).toBe("Alan Berezin");
    expect(await g.configGet("user.email")).toBe("alan@example.com");
    expect(await g.configGet("user.signingkey")).toBeUndefined();
  });
});

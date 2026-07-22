import { test, expect, describe } from "bun:test";
import { infraContext, projectProfile, projectContext, INFRA_PROFILE } from "./Docker.ts";

describe("docker context / colima profile helpers — pure name formatting", () => {
  test("infraContext matches bash 'colima-cb-infra'", () => {
    expect(infraContext()).toBe("colima-cb-infra");
    expect(INFRA_PROFILE).toBe("cb-infra");
  });

  test("projectProfile prefixes 'cb-' onto the id (matches wrapper.sh:548)", () => {
    expect(projectProfile("abc12345")).toBe("cb-abc12345");
  });

  test("projectContext prefixes 'colima-cb-' onto the id (matches wrapper.sh:549)", () => {
    expect(projectContext("abc12345")).toBe("colima-cb-abc12345");
  });
});

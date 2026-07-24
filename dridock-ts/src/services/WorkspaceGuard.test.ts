import { test, expect, describe } from "bun:test";
import { guardWorkspace } from "./WorkspaceGuard.ts";

describe("guardWorkspace", () => {
  test("normal cwd -> ok", () => {
    expect(guardWorkspace("/repo", {}, "/repo").kind).toBe("ok");
  });

  test("cwd is exactly a project's .dridock -> in-dotdir with suggested cd", () => {
    const v = guardWorkspace("/repo/.dridock", {}, "/repo");
    expect(v).toEqual({ kind: "in-dotdir", dotName: ".dridock", suggestedCd: "/repo" });
  });

  test("cwd inside .dridock/ subdir -> in-dotdir", () => {
    const v = guardWorkspace("/repo/.dridock/host-agent", {}, "/repo");
    expect(v.kind).toBe("in-dotdir");
    if (v.kind === "in-dotdir") expect(v.dotName).toBe(".dridock");
  });

  test("legacy .claudebox path detected", () => {
    const v = guardWorkspace("/legacy/.claudebox", {}, "/legacy");
    expect(v).toEqual({ kind: "in-dotdir", dotName: ".claudebox", suggestedCd: "/legacy" });
  });

  test("DRIDOCK_ALLOW_SUBDIR=1 overrides", () => {
    expect(guardWorkspace("/repo/.dridock", { DRIDOCK_ALLOW_SUBDIR: "1" }, "/repo").kind).toBe("ok");
  });

  test("legacy CLAUDEBOX_ALLOW_SUBDIR=1 also overrides (one deprecation cycle)", () => {
    expect(guardWorkspace("/repo/.dridock", { CLAUDEBOX_ALLOW_SUBDIR: "true" }, "/repo").kind).toBe("ok");
  });

  test("random truthy strings don't override — only whitelist values", () => {
    expect(guardWorkspace("/repo/.dridock", { DRIDOCK_ALLOW_SUBDIR: "no" }, "/repo").kind).toBe("in-dotdir");
    expect(guardWorkspace("/repo/.dridock", { DRIDOCK_ALLOW_SUBDIR: "" }, "/repo").kind).toBe("in-dotdir");
  });
});

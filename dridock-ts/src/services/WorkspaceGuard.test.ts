import { test, expect, describe } from "bun:test";
import { guardWorkspace, notRootMessage } from "./WorkspaceGuard.ts";

describe("guardWorkspace — launch only from the project root (#123)", () => {
  test("cwd is the root → ok", () => {
    expect(guardWorkspace("/repo", {}, "/repo").kind).toBe("ok");
  });

  test("a trailing slash on either side doesn't matter", () => {
    expect(guardWorkspace("/repo/", {}, "/repo").kind).toBe("ok");
    expect(guardWorkspace("/repo", {}, "/repo/").kind).toBe("ok");
  });

  test("a subdirectory → not-root, naming the root", () => {
    const v = guardWorkspace("/repo/src", {}, "/repo");
    expect(v).toEqual({ kind: "not-root", root: "/repo", notes: [] });
  });

  test("inside .dridock is just a subdirectory (the pre-6.0 dotdir guard, subsumed)", () => {
    expect(guardWorkspace("/repo/.dridock", {}, "/repo").kind).toBe("not-root");
    expect(guardWorkspace("/legacy/.claudebox/x", {}, "/legacy").kind).toBe("not-root");
  });

  test("DRIDOCK_NO_AUTO_MIGRATE (#135) is reported too, with its own reason", () => {
    const v = guardWorkspace("/repo", { DRIDOCK_NO_AUTO_MIGRATE: "1" }, "/repo");
    expect(v.kind).toBe("ok");
    expect(v.notes.join("")).toContain("DRIDOCK_NO_AUTO_MIGRATE=1 no longer does anything (removed in 6.0.0, #135");
  });

  test("DRIDOCK_ALLOW_SUBDIR no longer overrides anything, and says so", () => {
    const v = guardWorkspace("/repo/src", { DRIDOCK_ALLOW_SUBDIR: "1" }, "/repo");
    expect(v.kind).toBe("not-root");
    expect(v.notes.join("")).toContain("DRIDOCK_ALLOW_SUBDIR=1 no longer does anything");
  });

  test("the removal note fires at the root too (the setting is dead everywhere)", () => {
    const v = guardWorkspace("/repo", { DRIDOCK_ALLOW_SUBDIR: "1" }, "/repo");
    expect(v.kind).toBe("ok");
    expect(v.notes.length).toBe(1);
  });

  test("the refusal names where you are, the root, and the cd", () => {
    const m = notRootMessage("/repo/src", "/repo", "dridock", "start");
    expect(m).toContain("/repo/src");
    expect(m).toContain("cd /repo && dridock start");
  });
});

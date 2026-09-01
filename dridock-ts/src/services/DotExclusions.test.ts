import { test, expect, describe } from "bun:test";
import { dotExclusionVolumes, dotVolumePrefix, DOT_EXCLUDED_PATHS } from "./DotExclusions.ts";

describe("DotExclusions", () => {
  test("every excluded path gets a volume at a DEEPER path than the $HOME bind", () => {
    const vols = dotExclusionVolumes("abc");
    expect(vols.length).toBe(DOT_EXCLUDED_PATHS.length);
    for (const v of vols) {
      // Deeper than /home/claude is what makes docker layer it ON TOP of the
      // $HOME bind and shadow that subtree. A path equal to the bind would
      // replace the mount entirely.
      expect(v.container.startsWith("/home/claude/")).toBe(true);
      expect(v.container).not.toBe("/home/claude");
    }
  });

  test("volume names are valid docker names (no slashes or leading dot)", () => {
    for (const v of dotExclusionVolumes("abc")) {
      // docker: [a-zA-Z0-9][a-zA-Z0-9_.-] — a raw path would be rejected by
      // the daemon at run time, which is a terrible place to find out.
      expect(v.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    }
  });

  test("names are project-scoped, so two projects never share a cache", () => {
    const a = dotExclusionVolumes("aaa").map((v) => v.name);
    const b = dotExclusionVolumes("bbb").map((v) => v.name);
    expect(a.some((n) => b.includes(n))).toBe(false);
    expect(a.every((n) => n.startsWith(dotVolumePrefix("aaa")))).toBe(true);
  });

  test("the paths that motivated this are covered", () => {
    const containers = dotExclusionVolumes("abc").map((v) => v.container);
    // ~/.npm and ~/.cache are the many-small-files directories that make a
    // macOS bind mount slow — the performance half of why exclusions exist.
    expect(containers).toContain("/home/claude/.npm");
    expect(containers).toContain("/home/claude/.cache");
  });
});

import { test, expect, describe } from "bun:test";
import { containerName } from "./ContainerName.ts";

describe("containerName — the wrapper.sh sed 's#/#_#g' translation", () => {
  test("interactive role: claude-<pwd> with slashes → underscores", () => {
    expect(containerName("/home/alan/dev/proj-a")).toBe("claude-_home_alan_dev_proj-a");
  });

  test("programmatic role appends _prog", () => {
    expect(containerName("/p", "programmatic")).toBe("claude-_p_prog");
  });

  test("cron role appends _cron", () => {
    expect(containerName("/p", "cron")).toBe("claude-_p_cron");
  });

  test("root '/' → 'claude-_'", () => {
    expect(containerName("/")).toBe("claude-_");
  });

  test("no slashes (bare word) → 'claude-<word>'", () => {
    expect(containerName("bareword")).toBe("claude-bareword");
  });

  test("path with dots + hyphens preserved (docker allows them in names)", () => {
    expect(containerName("/my.app/v1-final"))
      .toBe("claude-_my.app_v1-final");
  });
});

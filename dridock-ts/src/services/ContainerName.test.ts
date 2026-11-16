import { test, expect, describe } from "bun:test";
import { containerName, legacyContainerName, sanitizeProjectName } from "./ContainerName.ts";

describe("containerName — keyed on declared identity, not the path (#123)", () => {
  test("name + id: claude-<name>-<id>", () => {
    expect(containerName({ name: "myproj", id: "69adc719" })).toBe("claude-myproj-69adc719");
  });

  test("programmatic and cron roles append _prog / _cron", () => {
    expect(containerName({ name: "p", id: "1" }, "programmatic")).toBe("claude-p-1_prog");
    expect(containerName({ name: "p", id: "1" }, "cron")).toBe("claude-p-1_cron");
  });

  test("no name (or empty) → claude-<id>, still unique", () => {
    expect(containerName({ id: "69adc719" })).toBe("claude-69adc719");
    expect(containerName({ name: "", id: "69adc719" })).toBe("claude-69adc719");
  });

  test("two clones share a name and differ by id — the design working, not a collision", () => {
    expect(containerName({ name: "myproj", id: "aaa" })).not.toBe(containerName({ name: "myproj", id: "bbb" }));
  });
});

describe("legacyContainerName — the pre-6.0 path form, kept for adoption only", () => {
  test("claude-<pwd> with slashes → underscores", () => {
    expect(legacyContainerName("/home/alan/dev/proj-a")).toBe("claude-_home_alan_dev_proj-a");
  });

  test("roles", () => {
    expect(legacyContainerName("/p", "programmatic")).toBe("claude-_p_prog");
    expect(legacyContainerName("/p", "cron")).toBe("claude-_p_cron");
  });

  test("dots + hyphens preserved", () => {
    expect(legacyContainerName("/my.app/v1-final")).toBe("claude-_my.app_v1-final");
  });
});

describe("sanitizeProjectName", () => {
  test("lowercases and maps everything outside [a-z0-9-] to -", () => {
    expect(sanitizeProjectName("My Proj")).toBe("my-proj");
    expect(sanitizeProjectName("docker_claudebox.in")).toBe("docker-claudebox-in");
  });

  test("collapses runs and trims the ends", () => {
    expect(sanitizeProjectName("--a__b  c--")).toBe("a-b-c");
  });

  test("nothing usable → empty string (caller decides: refuse or fall back)", () => {
    expect(sanitizeProjectName("___")).toBe("");
    expect(sanitizeProjectName("日本")).toBe("");
  });

  test("an already-clean name is unchanged", () => {
    expect(sanitizeProjectName("docker-claudebox-in-claudebox")).toBe("docker-claudebox-in-claudebox");
  });
});

import { test, expect, describe } from "bun:test";
import { ProjectRootResolver } from "./ProjectRoot.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../test/fakes/StubGitToplevel.ts";

describe("ProjectRootResolver.resolve", () => {
  test("uses git toplevel when available (matches bash `git -C … rev-parse --show-toplevel`)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/repo/root/.dridock");
    const r = await new ProjectRootResolver(fs, new StubGitToplevel("/repo/root"))
      .resolve("/repo/root/subdir");
    expect(r.root).toBe("/repo/root");
    expect(r.dotDir).toBe("/repo/root/.dridock");
    expect(r.dotName).toBe(".dridock");
    expect(r.configPath).toBe("/repo/root/.dridock/config.yml");
  });

  test("falls back to cwd when git returns undefined (bare directory case)", async () => {
    const fs = new InMemoryFileSystem();
    const r = await new ProjectRootResolver(fs, new StubGitToplevel(undefined))
      .resolve("/scratch");
    expect(r.root).toBe("/scratch");
  });

  test("prefers .dridock when both metadata dirs exist (mid-migration)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/p/.dridock");
    fs.seedDir("/p/.claudebox");
    const r = await new ProjectRootResolver(fs, new StubGitToplevel("/p")).resolve("/p");
    expect(r.dotName).toBe(".dridock");
  });

  test("uses legacy .claudebox when only that exists (pre-migration)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/legacy/.claudebox");
    const r = await new ProjectRootResolver(fs, new StubGitToplevel("/legacy")).resolve("/legacy");
    expect(r.dotName).toBe(".claudebox");
    expect(r.dotDir).toBe("/legacy/.claudebox");
    expect(r.configPath).toBe("/legacy/.claudebox/config.yml");
  });

  test("returns canonical .dridock path when neither exists (fresh bootstrap)", async () => {
    const fs = new InMemoryFileSystem();
    const r = await new ProjectRootResolver(fs, new StubGitToplevel("/new")).resolve("/new");
    expect(r.dotName).toBe(".dridock");
    expect(r.dotDir).toBe("/new/.dridock");
  });
});

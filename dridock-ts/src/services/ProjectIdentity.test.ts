import { test, expect, describe } from "bun:test";
import { resolveIdentity } from "./ProjectIdentity.ts";
import { ProjectConfig } from "./ProjectConfig.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

const PROJECT = { root: "/u/dev/My_Proj", projectPath: "/u/dev/My_Proj/.dridock/project.yml", dotName: ".dridock" };

function run(fs: InMemoryFileSystem, mode: "adopt" | "read-only", project = PROJECT): Promise<{ ident: Awaited<ReturnType<typeof resolveIdentity>>; warn: string }> {
  const msgs: string[] = [];
  return resolveIdentity(new ProjectConfig(fs), project, "abc", mode, (m) => msgs.push(m))
    .then((ident) => ({ ident, warn: msgs.join("") }));
}

describe("resolveIdentity (#123)", () => {
  test("declared name is used as is, silently", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT.projectPath, "name: stable\n");
    expect(await run(fs, "adopt")).toEqual({ ident: { name: "stable", id: "abc" }, warn: "" });
  });

  test("declared name needing sanitizing is used sanitized, and says so", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT.projectPath, "name: My Proj\n");
    const r = await run(fs, "read-only");
    expect(r.ident).toEqual({ name: "my-proj", id: "abc" });
    expect(r.warn).toContain("is used as 'my-proj'");
  });

  test("declared name with nothing usable → claude-<id>, said once", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJECT.projectPath, "name: ___\n");
    const r = await run(fs, "adopt");
    expect(r.ident).toEqual({ id: "abc" });
    expect(r.warn).toContain("claude-abc");
  });

  test("no name, adopt mode → inferred from the root, WRITTEN once, announced", async () => {
    const fs = new InMemoryFileSystem();
    const r = await run(fs, "adopt");
    expect(r.ident).toEqual({ name: "my-proj", id: "abc" });
    expect(r.warn).toContain("wrote  name: my-proj");
    expect(await fs.readText(PROJECT.projectPath)).toContain("\nname: my-proj\n");
    // Second call reads it back: no second write, no note.
    expect(await run(fs, "adopt")).toEqual({ ident: { name: "my-proj", id: "abc" }, warn: "" });
  });

  test("no name, read-only mode → same inference, nothing written", async () => {
    const fs = new InMemoryFileSystem();
    const r = await run(fs, "read-only");
    expect(r.ident).toEqual({ name: "my-proj", id: "abc" });
    expect(await fs.exists(PROJECT.projectPath)).toBe(false);
  });

  test("no name and an unusable basename → claude-<id>; adopt mode says how to add one", async () => {
    const fs = new InMemoryFileSystem();
    const odd = { root: "/u/___", projectPath: "/u/___/.dridock/project.yml", dotName: ".dridock" };
    const r = await run(fs, "adopt", odd);
    expect(r.ident).toEqual({ id: "abc" });
    expect(r.warn).toContain("name: my-project");
    expect(await fs.exists(odd.projectPath)).toBe(false);
  });
});

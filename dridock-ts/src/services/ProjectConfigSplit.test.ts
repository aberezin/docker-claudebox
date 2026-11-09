import { test, expect, describe } from "bun:test";
import {
  ProjectConfig,
  stripListBlock,
  rewriteListBlock,
  unionLists,
  legacyLocationNotice,
  PLUGIN_SPEC_REGEX,
  PROJECT_YML_HEADER,
} from "./ProjectConfig.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

/**
 * #97 — project-level config split out of the gitignored config.yml.
 *
 * The defect being fixed: `features:` (since 3.x) and `plugins:` (#96) are
 * properties of the PROJECT — identical in every clone — but lived in
 * `config.yml`, which dridock gitignores because of `id`/`vm.*`/
 * `network.hostname`. So a project could not state its own tool or plugin set
 * in a way that survived a clone.
 *
 * What these tests pin, in order of how much it would hurt to regress:
 *   1. Reads are a UNION, not an override — a pre-#97 project keeps working.
 *   2. The legacy location is reported, never silently honored-and-forgotten.
 *   3. project.yml is created lazily, with the header that documents the split.
 *   4. Rewriting one key leaves the other key (and comments) intact.
 *   5. The plugin-shape regex is ONE source of truth with the parser.
 */

const CFG = "/p/.dridock/config.yml";
const PROJ = "/p/.dridock/project.yml";

describe("#97 read resolution — union across both files", () => {
  test("project.yml ∪ config.yml, project entries first", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\nfeatures: [python]\n");
    fs.seed(PROJ, "features: [typescript]\n");
    const r = await new ProjectConfig(fs).featuresResolved(CFG, PROJ);
    expect(r.values).toEqual(["typescript", "python"]);
  });

  test("a config.yml-only entry still applies — union, NOT override", async () => {
    // Mutation guard: swap `unionLists` for "project.yml wins if present" and
    // this is the test that fails. A pre-#97 project whose features silently
    // stopped installing after an upgrade is the regression being prevented.
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\nfeatures: [python, go]\n");
    fs.seed(PROJ, "features: [typescript]\n");
    const r = await new ProjectConfig(fs).featuresResolved(CFG, PROJ);
    expect(r.values).toContain("python");
    expect(r.values).toContain("go");
  });

  test("an entry in BOTH files appears once", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "features: [typescript]\n");
    fs.seed(PROJ, "features: [typescript]\n");
    const r = await new ProjectConfig(fs).featuresResolved(CFG, PROJ);
    expect(r.values).toEqual(["typescript"]);
  });

  test("neither file exists -> empty, no throw", async () => {
    const fs = new InMemoryFileSystem();
    const cfg = new ProjectConfig(fs);
    expect((await cfg.featuresResolved(CFG, PROJ)).values).toEqual([]);
    expect((await cfg.pluginsResolved(CFG, PROJ)).values).toEqual([]);
  });

  test("plugins resolve the same way", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "plugins: [old@a/b]\n");
    fs.seed(PROJ, "plugins: [superpowers@aberezin/superpowers]\n");
    const r = await new ProjectConfig(fs).pluginsResolved(CFG, PROJ);
    expect(r.values).toEqual(["superpowers@aberezin/superpowers", "old@a/b"]);
  });

  test("legacy `profiles:` spelling in config.yml is still honored", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "profiles: [typescript]\n");
    const r = await new ProjectConfig(fs).featuresResolved(CFG, PROJ);
    expect(r.values).toEqual(["typescript"]);
  });
});

describe("#97 legacy location is reported, not silently absorbed", () => {
  test("config.yml entries land in .legacy", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "features: [python]\n");
    fs.seed(PROJ, "features: [typescript]\n");
    const r = await new ProjectConfig(fs).featuresResolved(CFG, PROJ);
    expect(r.legacy).toEqual(["python"]);
  });

  test("entries only in project.yml leave .legacy empty — no false nudge", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    fs.seed(PROJ, "features: [typescript]\n");
    const r = await new ProjectConfig(fs).featuresResolved(CFG, PROJ);
    expect(r.legacy).toEqual([]);
  });

  test("the notice names the file, the entries, and the removal release", () => {
    const msg = legacyLocationNotice("plugins", ["a@o/r"], ".dridock");
    expect(msg).toContain(".dridock/config.yml");
    expect(msg).toContain("a@o/r");
    expect(msg).toContain(".dridock/project.yml");
    expect(msg).toContain("7.0.0");
    // It must not read as "ignored" — the entries ARE applied.
    expect(msg).toContain("still applied");
  });
});

describe("#97 project.yml is created lazily, with the explanatory header", () => {
  test("absent project.yml -> created, carrying the header", async () => {
    const fs = new InMemoryFileSystem();
    await new ProjectConfig(fs).setProjectList(PROJ, "features", ["typescript"]);
    const text = await fs.readText(PROJ);
    expect(text).toContain("features: [typescript]");
    expect(text).toContain("COMMIT THIS FILE");
    expect(text).toContain("config.yml");
  });

  test("the header explains what belongs in the OTHER file", () => {
    // The file is tracked, so its header is the documentation a reader
    // actually meets. If this ever stops mentioning both halves, the split
    // becomes folklore.
    expect(PROJECT_YML_HEADER).toContain("project.yml");
    expect(PROJECT_YML_HEADER).toContain("config.yml");
    expect(PROJECT_YML_HEADER).toContain("features:");
    expect(PROJECT_YML_HEADER).toContain("plugins:");
  });

  test("writing features leaves an existing plugins: block alone", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, "# hand-written\nplugins: [superpowers@aberezin/superpowers]\n");
    await new ProjectConfig(fs).setProjectList(PROJ, "features", ["typescript"]);
    const text = await fs.readText(PROJ);
    expect(text).toContain("plugins: [superpowers@aberezin/superpowers]");
    expect(text).toContain("features: [typescript]");
    expect(text).toContain("# hand-written");
  });

  test("writing plugins leaves an existing features: block alone", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, "features: [typescript]\n");
    await new ProjectConfig(fs).setProjectList(PROJ, "plugins", ["a@o/r"]);
    const text = await fs.readText(PROJ);
    expect(text).toContain("features: [typescript]");
    expect(text).toContain("plugins: [a@o/r]");
  });

  test("empty list removes the block but keeps the file", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, "plugins: [a@o/r]\nfeatures: [typescript]\n");
    await new ProjectConfig(fs).setProjectList(PROJ, "features", []);
    const text = await fs.readText(PROJ);
    expect(text).not.toContain("features:");
    expect(text).toContain("plugins: [a@o/r]");
  });

  test("setExistingList refuses to create a file", async () => {
    const fs = new InMemoryFileSystem();
    let threw = false;
    try {
      await new ProjectConfig(fs).setExistingList(CFG, "features", ["typescript"]);
    } catch { threw = true; }
    expect(threw).toBe(true);
    // Crucially it did NOT scaffold a config.yml — that file is the project
    // sentinel, and conjuring one as a side effect of a removal would make a
    // non-project look like a project.
    expect(await fs.readTextOrUndefined(CFG)).toBeUndefined();
  });
});

describe("#97 stripListBlock generality", () => {
  test("block form, and the following key survives", () => {
    const out = stripListBlock("features:\n  - typescript\n  - python\nid: abc\n", "features");
    expect(out).not.toContain("typescript");
    expect(out).toContain("id: abc");
  });

  test("stripping features does not touch plugins", () => {
    const out = stripListBlock("features: [a]\nplugins: [x@o/r]\n", "features");
    expect(out).not.toContain("features:");
    expect(out).toContain("plugins: [x@o/r]");
  });

  test("stripping plugins does not touch features or its legacy spelling", () => {
    const out = stripListBlock("profiles: [a]\nplugins: [x@o/r]\n", "plugins");
    expect(out).toContain("profiles: [a]");
    expect(out).not.toContain("plugins:");
  });

  test("rewriteListBlock on empty names emits no key", () => {
    expect(rewriteListBlock("features: [a]\nid: x\n", "features", [])).not.toContain("features:");
  });
});

describe("#97 unionLists is a pure function", () => {
  test("order preserved, duplicates dropped, inputs untouched", () => {
    const a = ["x", "y"];
    const b = ["y", "z"];
    const r = unionLists(a, b);
    expect(r.values).toEqual(["x", "y", "z"]);
    expect(r.legacy).toEqual(["y", "z"]);
    expect(a).toEqual(["x", "y"]);
    expect(b).toEqual(["y", "z"]);
  });
});

describe("#97 PLUGIN_SPEC_REGEX is shared with the parser", () => {
  test("accepts the real-world spec", () => {
    expect(PLUGIN_SPEC_REGEX.test("superpowers@aberezin/superpowers")).toBe(true);
  });

  test("rejects the #96 injection string", () => {
    // The exact payload that got through the original permissive regex and
    // parsed as three shell commands under the entrypoint's `bash -c`.
    expect(PLUGIN_SPEC_REGEX.test("x@a/b';touch /tmp/INJECTED;'")).toBe(false);
  });

  test("rejects a version-pinned spec — pinning is not expressible", () => {
    // Documents the answer to the open question on #95: a marketplace tracks
    // its HEAD. A second `@` cannot even parse, so "pin the fork" is a syntax
    // change, not a config choice.
    expect(PLUGIN_SPEC_REGEX.test("superpowers@aberezin/superpowers@v7.0.2")).toBe(false);
  });

  test("rejects short form and bare names", () => {
    expect(PLUGIN_SPEC_REGEX.test("superpowers@marketplace")).toBe(false);
    expect(PLUGIN_SPEC_REGEX.test("superpowers")).toBe(false);
  });
});

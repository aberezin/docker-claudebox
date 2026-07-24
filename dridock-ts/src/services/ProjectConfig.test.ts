import { test, expect, describe } from "bun:test";
import { ProjectConfig, parseFeatures, parseTopLevelString, stripFeaturesBlock } from "./ProjectConfig.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

describe("parseFeatures — YAML tolerance (matches wrapper.sh awk)", () => {
  test("flow style", () => {
    expect(parseFeatures("features: [typescript, python, go]\n"))
      .toEqual(["typescript", "python", "go"]);
  });

  test("block style", () => {
    expect(parseFeatures([
      "features:",
      "  - typescript",
      "  - python",
      "  - go",
      "",
    ].join("\n"))).toEqual(["typescript", "python", "go"]);
  });

  test("legacy 'profiles:' key accepted (2.x compat)", () => {
    expect(parseFeatures("profiles: [typescript]\n")).toEqual(["typescript"]);
  });

  test("both keys present -> both feed the list (deduped)", () => {
    const text = "features: [typescript]\nprofiles: [typescript, python]\n";
    expect(parseFeatures(text)).toEqual(["typescript", "python"]);
  });

  test("empty flow list", () => {
    expect(parseFeatures("features: []\n")).toEqual([]);
  });

  test("no features/profiles key -> empty", () => {
    expect(parseFeatures("vm:\n  disk: 60G\nnetwork:\n  hostname: foo\n")).toEqual([]);
  });

  test("block form: comment lines + blank lines don't end the block", () => {
    expect(parseFeatures([
      "features:",
      "  # commented",
      "",
      "  - typescript",
      "  # another",
      "  - python",
      "",
    ].join("\n"))).toEqual(["typescript", "python"]);
  });

  test("block form: sibling YAML key ends the block", () => {
    expect(parseFeatures([
      "features:",
      "  - typescript",
      "vm:",
      "  disk: 60G",
      "  - not-a-feature",
      "",
    ].join("\n"))).toEqual(["typescript"]);
  });

  test("garbage chars scrubbed to identifier chars (matches awk gsub)", () => {
    expect(parseFeatures("features: [ 'foo!bar', \"baz@qux\" ]\n"))
      .toEqual(["foobar", "bazqux"]);
  });

  test("inline # comment stripped from block item", () => {
    expect(parseFeatures([
      "features:",
      "  - typescript  # my favorite",
      "",
    ].join("\n"))).toEqual(["typescript"]);
  });

  test("dedup preserves first-occurrence order", () => {
    expect(parseFeatures([
      "features:",
      "  - typescript",
      "  - python",
      "  - typescript",
      "",
    ].join("\n"))).toEqual(["typescript", "python"]);
  });
});

describe("parseTopLevelString — flat YAML KEY: VALUE (matches _cb_yaml_get)", () => {
  test("basic key + value", () => {
    expect(parseTopLevelString("id: abc12345\n", "id")).toBe("abc12345");
  });
  test("skips indented keys — nested `id` under `vm:` doesn't shadow top-level", () => {
    const y = "vm:\n  id: nested-should-be-ignored\nid: real-id\n";
    expect(parseTopLevelString(y, "id")).toBe("real-id");
  });
  test("strips trailing '# comment'", () => {
    expect(parseTopLevelString("id: abc  # scratch\n", "id")).toBe("abc");
  });
  test("strips matching double-quote wrap", () => {
    expect(parseTopLevelString('id: "abc"\n', "id")).toBe("abc");
  });
  test("strips matching single-quote wrap", () => {
    expect(parseTopLevelString("id: 'abc'\n", "id")).toBe("abc");
  });
  test("empty value -> undefined", () => {
    expect(parseTopLevelString("id: \n", "id")).toBeUndefined();
  });
  test("missing key -> undefined", () => {
    expect(parseTopLevelString("vm:\n  disk: 60G\n", "id")).toBeUndefined();
  });
});

describe("stripFeaturesBlock — the awk at wrapper.sh:1352", () => {
  test("strips flow-style features:", () => {
    expect(stripFeaturesBlock("id: abc\nfeatures: [x, y]\nvm:\n  cpu: 4\n"))
      .toBe("id: abc\nvm:\n  cpu: 4\n");
  });
  test("strips flow-style profiles: (legacy)", () => {
    expect(stripFeaturesBlock("id: abc\nprofiles: [x]\n")).toBe("id: abc\n");
  });
  test("strips block-style features: with items", () => {
    const before = ["id: abc", "features:", "  - x", "  - y", "vm:", "  cpu: 4", ""].join("\n");
    expect(stripFeaturesBlock(before)).toBe(["id: abc", "vm:", "  cpu: 4", ""].join("\n"));
  });
  test("block-style: blank + comment lines inside block don't end it", () => {
    const before = ["id: abc", "features:", "  # comment", "", "  - x", "vm:", "  cpu: 4", ""].join("\n");
    expect(stripFeaturesBlock(before)).toBe(["id: abc", "vm:", "  cpu: 4", ""].join("\n"));
  });
  test("keeps unrelated content intact", () => {
    const before = "vm:\n  cpu: 4\nnetwork:\n  hostname: foo\n";
    expect(stripFeaturesBlock(before)).toBe(before);
  });
});

describe("ProjectConfig.setFeatures — safe rewrite (writeTextAtomic under the hood)", () => {
  test("writes flow-style block, atomic", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nvm:\n  cpu: 4\n");
    await new ProjectConfig(fs).setFeatures("/p/.dridock/config.yml", ["typescript", "python"]);
    const out = await fs.readText("/p/.dridock/config.yml");
    expect(out).toContain("id: abc");
    expect(out).toContain("vm:");
    expect(out).toContain("features: [typescript, python]");
    expect(fs.recordedWrites.some((w) => w.path === "/p/.dridock/config.yml")).toBe(true);
  });

  test("replaces an existing flow-style block (no duplication)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [old]\nvm:\n  cpu: 4\n");
    await new ProjectConfig(fs).setFeatures("/p/.dridock/config.yml", ["new"]);
    const out = await fs.readText("/p/.dridock/config.yml");
    expect(out).toContain("features: [new]");
    expect(out).not.toContain("features: [old]");
    // Only ONE features: line total (no duplication)
    expect(out.match(/^\s*features:/gm)?.length ?? 0).toBe(1);
  });

  test("replaces an existing block-style block", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures:\n  - old\nvm:\n  cpu: 4\n");
    await new ProjectConfig(fs).setFeatures("/p/.dridock/config.yml", ["new"]);
    const out = await fs.readText("/p/.dridock/config.yml");
    expect(out).toContain("features: [new]");
    expect(out).not.toContain("- old");
  });

  test("empty names removes the block entirely", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [x]\n");
    await new ProjectConfig(fs).setFeatures("/p/.dridock/config.yml", []);
    const out = await fs.readText("/p/.dridock/config.yml");
    expect(out).not.toContain("features:");
    expect(out).toContain("id: abc");
  });

  test("throws when config.yml missing (matches bash's `no config.yml at $cfg`)", async () => {
    const fs = new InMemoryFileSystem();
    await expect(new ProjectConfig(fs).setFeatures("/p/.dridock/config.yml", ["x"]))
      .rejects.toThrow(/no config.yml/);
  });
});

describe("ProjectConfig.projectId", () => {
  test("returns id when present + not 'auto'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc12345\n");
    expect(await new ProjectConfig(fs).projectId("/p/.dridock/config.yml")).toBe("abc12345");
  });
  test("returns undefined for 'auto' sentinel (means: bootstrap not run yet)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: auto\n");
    expect(await new ProjectConfig(fs).projectId("/p/.dridock/config.yml")).toBeUndefined();
  });
  test("returns undefined when config.yml missing (matches cb_project_id_ro)", async () => {
    const fs = new InMemoryFileSystem();
    expect(await new ProjectConfig(fs).projectId("/p/.dridock/config.yml")).toBeUndefined();
  });
});

describe("ProjectConfig.features", () => {
  test("returns [] when config.yml is missing (matches bash's silent-empty)", async () => {
    const fs = new InMemoryFileSystem();
    expect(await new ProjectConfig(fs).features("/p/.dridock/config.yml")).toEqual([]);
  });

  test("reads through to parseFeatures", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "features: [typescript]\n");
    expect(await new ProjectConfig(fs).features("/p/.dridock/config.yml"))
      .toEqual(["typescript"]);
  });
});

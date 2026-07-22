import { test, expect, describe } from "bun:test";
import { ProjectConfig, parseFeatures } from "./ProjectConfig.ts";
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

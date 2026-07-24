import { test, expect, describe } from "bun:test";
import { configHome, xdgRoot, stateHome } from "./paths.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

describe("configHome", () => {
  test("defaults to $HOME/.config when XDG_CONFIG_HOME unset", () => {
    expect(configHome({}, "/home/alan")).toBe("/home/alan/.config");
  });
  test("honors XDG_CONFIG_HOME when set", () => {
    expect(configHome({ XDG_CONFIG_HOME: "/custom" }, "/home/alan")).toBe("/custom");
  });
});

describe("xdgRoot — dridock/ preferred, claudebox/ fallback (matches cb_xdg_dir)", () => {
  test("returns dridock/ when it exists", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/home/alan/.config/dridock");
    fs.seedDir("/home/alan/.config/claudebox");   // both exist — dridock wins
    expect(await xdgRoot(fs, {}, "/home/alan")).toBe("/home/alan/.config/dridock");
  });

  test("falls back to claudebox/ when only legacy exists (mid-migration)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/home/alan/.config/claudebox");
    expect(await xdgRoot(fs, {}, "/home/alan")).toBe("/home/alan/.config/claudebox");
  });

  test("returns dridock/ (canonical) when neither exists — for fresh mkdir", async () => {
    const fs = new InMemoryFileSystem();
    expect(await xdgRoot(fs, {}, "/home/alan")).toBe("/home/alan/.config/dridock");
  });
});

describe("stateHome — per-subdir preference (post-3.2.4 #29 fix)", () => {
  test("uses dridock/ subdir when it exists (even if legacy claudebox/ root exists too)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/home/alan/.config/dridock/consult");
    fs.seedDir("/home/alan/.config/claudebox/consult");
    expect(await stateHome(fs, {}, "/home/alan", "consult")).toBe("/home/alan/.config/dridock/consult");
  });

  test("uses legacy claudebox/ subdir when only it has this specific state (per-subdir migration)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/home/alan/.config/dridock");   // dridock root exists…
    fs.seedDir("/home/alan/.config/claudebox/framework-bugs");   // …but this subdir is only legacy
    expect(await stateHome(fs, {}, "/home/alan", "framework-bugs")).toBe("/home/alan/.config/claudebox/framework-bugs");
  });

  test("returns dridock/ (canonical) for fresh setup with no existing state", async () => {
    const fs = new InMemoryFileSystem();
    expect(await stateHome(fs, {}, "/home/alan", "cdp")).toBe("/home/alan/.config/dridock/cdp");
  });
});

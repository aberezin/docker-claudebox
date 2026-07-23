import { test, expect, describe } from "bun:test";
import { MachineConfig } from "./MachineConfig.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

const HOME = "/home/alan";

describe("MachineConfig.projectDataDir — bash-parity resolution", () => {
  test("no machine config → baked default `<xdg>/projects/<id>/claude`", async () => {
    const fs = new InMemoryFileSystem();
    const mc = new MachineConfig(fs, {}, HOME);
    expect(await mc.projectDataDir("abc12345")).toBe("/home/alan/.config/dridock/projects/abc12345/claude");
  });

  test("machine config with `data_root: ~/custom` → ~-expanded + suffixed", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/config.yml", "data_root: ~/dridock-data\n");
    const mc = new MachineConfig(fs, {}, HOME);
    expect(await mc.projectDataDir("abc")).toBe("/home/alan/dridock-data/abc/claude");
  });

  test("machine config with absolute `data_root: /var/dridock` → NOT expanded", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/config.yml", "data_root: /var/dridock\n");
    const mc = new MachineConfig(fs, {}, HOME);
    expect(await mc.projectDataDir("abc")).toBe("/var/dridock/abc/claude");
  });

  test("DRIDOCK_DATA_DIR env override wins over machine config (bash-parity wrapper.sh:2168)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/config.yml", "data_root: /var/dridock\n");
    const mc = new MachineConfig(fs, { DRIDOCK_DATA_DIR: "/tmp/override" }, HOME);
    // Env override is USED AS-IS — no /<id>/claude suffix appended (matches
    // wrapper.sh:2168 where CLAUDE_DIR is set directly from the env var).
    expect(await mc.projectDataDir("abc")).toBe("/tmp/override");
  });

  test("legacy CLAUDE_DATA_DIR still honored (deprecation cycle)", async () => {
    const fs = new InMemoryFileSystem();
    const mc = new MachineConfig(fs, { CLAUDE_DATA_DIR: "/tmp/legacy" }, HOME);
    expect(await mc.projectDataDir("abc")).toBe("/tmp/legacy");
  });

  test("DRIDOCK_DATA_DIR wins over legacy CLAUDE_DATA_DIR when both set", async () => {
    const fs = new InMemoryFileSystem();
    const mc = new MachineConfig(fs, { DRIDOCK_DATA_DIR: "/new", CLAUDE_DATA_DIR: "/old" }, HOME);
    expect(await mc.projectDataDir("abc")).toBe("/new");
  });

  test("empty env override falls through to machine config / baked default", async () => {
    const fs = new InMemoryFileSystem();
    const mc = new MachineConfig(fs, { DRIDOCK_DATA_DIR: "" }, HOME);
    expect(await mc.projectDataDir("abc")).toBe("/home/alan/.config/dridock/projects/abc/claude");
  });

  test("XDG_CONFIG_HOME override respected (baked default uses it)", async () => {
    const fs = new InMemoryFileSystem();
    const mc = new MachineConfig(fs, { XDG_CONFIG_HOME: "/custom-xdg" }, HOME);
    expect(await mc.projectDataDir("abc")).toBe("/custom-xdg/dridock/projects/abc/claude");
  });

  test("legacy claudebox/ xdg dir preferred as read source when only that exists", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/home/alan/.config/claudebox");   // only legacy present
    const mc = new MachineConfig(fs, {}, HOME);
    // Should resolve to the legacy path
    expect(await mc.projectDataDir("abc")).toBe("/home/alan/.config/claudebox/projects/abc/claude");
  });
});

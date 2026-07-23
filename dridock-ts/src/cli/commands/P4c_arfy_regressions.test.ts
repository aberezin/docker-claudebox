import { test, expect, describe } from "bun:test";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { InMemoryLimactl } from "../../test/fakes/InMemoryLimactl.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { InfoCommand } from "./InfoCommand.ts";
import { DestroyCommand } from "./DestroyCommand.ts";
import { parseNestedYaml, parseTopLevelString } from "../../services/ProjectConfig.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

describe("Arfy #38 P4c B1 — YAML parser strips inline # comments even on blank-value lines", () => {
  test("nested `hostname:               # comment` → undefined (empty value, not the comment)", () => {
    const doc = `id: abc
network:
  hostname:               # optional: set e.g. "myproj" for a friendly http://myproj:<port>
`;
    expect(parseNestedYaml(doc, "network", "hostname")).toBeUndefined();
  });

  test("nested `hostname: my-app # comment` → 'my-app'", () => {
    expect(parseNestedYaml(`network:\n  hostname: my-app # comment\n`, "network", "hostname")).toBe("my-app");
  });

  test("nested `hostname: my-app` → 'my-app'", () => {
    expect(parseNestedYaml(`network:\n  hostname: my-app\n`, "network", "hostname")).toBe("my-app");
  });

  test("top-level equivalent — `id: # comment` → undefined", () => {
    expect(parseTopLevelString(`id: # optional\n`, "id")).toBeUndefined();
  });

  test("top-level `id: real-id # trailing` → 'real-id'", () => {
    expect(parseTopLevelString(`id: real-id # trailing\n`, "id")).toBe("real-id");
  });

  test("value legitimately containing '#' without leading space → preserved (bash's `index(val,\" #\")` requires the space)", () => {
    expect(parseTopLevelString(`id: real#id\n`, "id")).toBe("real#id");
  });
});

describe("Arfy #38 P4c B2 — info container status uses psFilter (Up N min), not containerIdentity (.State.Status)", () => {
  test("container 'Up 3 minutes' rendered via ContainerRuntime.psFilter", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const runtime = new InMemoryContainerRuntime();
    runtime.seedPs("claude-_p", { name: "claude-_p", status: "Up 3 minutes", image: "dridock:latest" });
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), colima, runtime).run([], ctx);
    expect(stdout.text()).toContain("container:         claude-_p   Up 3 minutes");
    // NOT the previous ugly "<none>" from an empty .State.Status parse
    expect(stdout.text()).not.toContain("container:         claude-_p   <none>");
  });
});

describe("Arfy #38 P4c B4 — destroy always reaps the leaked lima datadisk + purge rms the parent projects/<id>", () => {
  test("destroy without --purge → still calls limactl.diskDelete for the leaked disk", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    // Seed LIMA_HOME so resolveLimaHome finds it
    fs.seedDir("/home/alan/.colima/_lima");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const limactl = new InMemoryLimactl();
    limactl.seedDisk({ name: "colima-cb-abc", max: "60GiB" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new DestroyCommand(colima, new StubGitToplevel("/p"), limactl).run([], ctx);
    expect(rc).toBe(0);
    // The critical bash-parity behavior: colima delete + limactl disk delete both fire
    expect(colima.deletions).toEqual(["cb-abc"]);
    expect(limactl.deletions).toEqual([["colima-cb-abc"]]);
    expect(stdout.text()).toContain("freed leaked lima datadisk (colima-cb-abc)");
  });

  test("destroy when VM already absent → STILL reaps the leaked disk (reclaims previously-leaked)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    fs.seedDir("/home/alan/.colima/_lima");
    const colima = new InMemoryColima();
    // No VM seeded — profile is absent
    const limactl = new InMemoryLimactl();
    limactl.seedDisk({ name: "colima-cb-abc", max: "60GiB" });
    const { ctx, stdout } = makeCtx(fs);
    await new DestroyCommand(colima, new StubGitToplevel("/p"), limactl).run([], ctx);
    // Colima delete not called (VM absent) but limactl STILL cleaned up
    expect(colima.deletions).toEqual([]);
    expect(limactl.deletions).toEqual([["colima-cb-abc"]]);
    expect(stdout.text()).toContain("no VM for this project (cb-abc)");
    expect(stdout.text()).toContain("freed leaked lima datadisk");
  });

  test("no LIMA_HOME → limactl skipped silently (matches bash's `if command -v limactl && lh=...`)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    // NO LIMA_HOME seeded — resolveLimaHome returns undefined
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const limactl = new InMemoryLimactl();
    const { ctx } = makeCtx(fs);
    await new DestroyCommand(colima, new StubGitToplevel("/p"), limactl).run([], ctx);
    // limactl not invoked (no LIMA_HOME to point it at)
    expect(limactl.deletions).toEqual([]);
  });

  test("--purge rms the PARENT projects/<id> dir (matches cb_purge_data at :826)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    fs.seed("/home/alan/.config/dridock/projects/abc/claude/session.json", "{}");
    fs.seed("/home/alan/.config/dridock/projects/abc/some-other-dir/plugin.json", "{}");
    const { ctx } = makeCtx(fs);
    await new DestroyCommand(new InMemoryColima(), new StubGitToplevel("/p")).run(["--purge"], ctx);
    // BOTH the claude subtree AND sibling dirs under /abc/ gone
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/claude/session.json")).toBe(false);
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc/some-other-dir/plugin.json")).toBe(false);
    // And the empty parent /abc/ itself
    expect(await fs.exists("/home/alan/.config/dridock/projects/abc")).toBe(false);
  });

  test("--purge refuses when project id fails the hex regex (bash `*[!0-9a-f]*` guard)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: NOT-hex-id!\n");
    fs.seed("/home/alan/.config/dridock/projects/NOT-hex-id!/x", "y");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new DestroyCommand(new InMemoryColima(), new StubGitToplevel("/p")).run(["--purge"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("refusing to purge — unexpected project id");
    // Data dir NOT touched
    expect(await fs.exists("/home/alan/.config/dridock/projects/NOT-hex-id!/x")).toBe(true);
  });

  test("--purge refuses when DRIDOCK_DATA_DIR override is set (path is arbitrary/user-owned)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    fs.seed("/tmp/override-data/session.json", "{}");
    const orig = process.env["DRIDOCK_DATA_DIR"];
    process.env["DRIDOCK_DATA_DIR"] = "/tmp/override-data";
    try {
      const { ctx, stderr } = makeCtx(fs);
      const rc = await new DestroyCommand(new InMemoryColima(), new StubGitToplevel("/p")).run(["--purge"], ctx);
      expect(rc).toBe(0);
      expect(stderr.text()).toContain("DRIDOCK_DATA_DIR override is set");
      // Override path NOT deleted
      expect(await fs.exists("/tmp/override-data/session.json")).toBe(true);
    } finally {
      if (orig === undefined) delete process.env["DRIDOCK_DATA_DIR"];
      else process.env["DRIDOCK_DATA_DIR"] = orig;
    }
  });
});

import { test, expect, describe } from "bun:test";
import { MigrateCommand } from "./MigrateCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StubProcessProbe } from "../../infra/ProcessProbe.ts";
import { FrozenClock } from "../../infra/Clock.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): {
  ctx: Context; stdout: StringWriter; stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  process.env["HOME"] = "/home/alan"; // for prettyPath
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

function newCmd(fs?: InMemoryFileSystem): MigrateCommand {
  void fs;
  return new MigrateCommand(new StubGitToplevel("/p"), new StubProcessProbe(), new FrozenClock("20260722010203"));
}

describe("MigrateCommand — happy paths", () => {
  test("no-op project → ✅ done, rc 0, no ⚠ lines", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await newCmd().run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("✅ done.");
    expect(stderr.text()).toBe("");
  });

  test("workspace + data-dir + state-dirs all migrate cleanly → rc 0", async () => {
    const fs = new InMemoryFileSystem();
    // Workspace files
    fs.seed("/p/.claudebox/config.yml", "id: abc\n");
    fs.seed("/p/.claudebox/secrets.env", "GH=1\n");
    // Data dir
    fs.seed("/home/alan/.config/claudebox/projects/abc/state.json", "{}");
    // Machine config
    fs.seed("/home/alan/.config/claudebox/config.yml", "data_root: ~/x\n");
    // State dir
    fs.seed("/home/alan/.config/claudebox/consult/thread-1/meta", "status=x\n");

    // The migrator needs the project id AFTER workspace migration to
    // find the data dir. The command reads config.yml at the resolved
    // dot dir; since .dridock/ won't exist until after WorkspaceMigrator
    // runs, ProjectRootResolver returns .claudebox as the dot dir and
    // reads id: abc from THERE. Verified by the test.
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await newCmd().run([], ctx);
    expect(rc).toBe(0);
    // No ⚠ warnings anywhere
    expect(stderr.text()).toBe("");
    // Final line
    expect(stdout.text()).toContain("✅ done.");
    // Files landed on the new side
    expect(await fs.readText("/p/.dridock/config.yml")).toBe("id: abc\n");
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc/state.json")).toBe("{}");
    expect(await fs.readText("/home/alan/.config/dridock/config.yml")).toBe("data_root: ~/x\n");
    expect(await fs.readText("/home/alan/.config/dridock/consult/thread-1/meta")).toBe("status=x\n");
  });
});

describe("MigrateCommand — audit rule (visible warning + non-zero rc)", () => {
  test("workspace split-brain → rc 1, ⚠ on stderr, both files intact", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.claudebox/config.yml", "old\n");
    fs.seed("/p/.dridock/config.yml", "new\n");
    const { ctx, stderr, stdout } = makeCtx(fs);
    const rc = await newCmd().run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("⚠");
    expect(stderr.text()).toContain("config.yml");
    expect(stdout.text()).toContain("⚠  done — but one or more state dirs were skipped");
    // Both preserved
    expect(await fs.readText("/p/.claudebox/config.yml")).toBe("old\n");
    expect(await fs.readText("/p/.dridock/config.yml")).toBe("new\n");
  });

  test("cdp live-Chrome guard → rc 1, ⚠ on stderr, cdp content untouched", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/cdp/marker", "x");
    const probe = new StubProcessProbe();
    probe.seedMatch("--user-data-dir=/home/alan/.config/claudebox/cdp", true);
    const cmd = new MigrateCommand(new StubGitToplevel("/p"), probe, new FrozenClock());
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("Chrome is running");
    // cdp preserved
    expect(await fs.readText("/home/alan/.config/claudebox/cdp/marker")).toBe("x");
  });

  test("split-brain merge (state dirs) with collisions → rc 1 + suffix mentioned", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/consult/only-old/x", "old");
    fs.seed("/home/alan/.config/claudebox/consult/shared/x", "old-shared");
    fs.seed("/home/alan/.config/dridock/consult/shared/x", "new-shared");
    const { ctx, stderr, stdout } = makeCtx(fs);
    const rc = await newCmd().run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("SPLIT-BRAIN merged");
    expect(stderr.text()).toContain(".legacy-20260722010203");
    expect(stdout.text()).toContain("⚠  done");
  });
});

describe("MigrateCommand — arg handling", () => {
  test("--help prints usage + rc 0", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await newCmd().run(["--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock migrate");
  });

  test("unknown arg → DridockError rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    try {
      await newCmd().run(["--nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as DridockError).exitCode).toBe(1);
    }
  });

  test("--all sweeps additional legacy project data dirs", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/projects/proj-one/state.json", "1");
    fs.seed("/home/alan/.config/claudebox/projects/proj-two/state.json", "2");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await newCmd().run(["--all"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("migrate --all: sweeping");
    expect(await fs.readText("/home/alan/.config/dridock/projects/proj-one/state.json")).toBe("1");
    expect(await fs.readText("/home/alan/.config/dridock/projects/proj-two/state.json")).toBe("2");
  });

  test("--all with no legacy projects/ → prints '(no legacy ... to sweep)' but still rc 0", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await newCmd().run(["--all"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("no legacy claudebox/projects/");
  });
});

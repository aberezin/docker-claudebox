import { test, expect, describe } from "bun:test";
import { FeaturesCommand } from "./FeaturesCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

/** Assemble a Context wired with in-memory fakes + a stubbed git toplevel. */
function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): {
  ctx: Context; stdout: StringWriter; stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: {
      fs, env: new EnvResolver({}),
      cwd, home: "/home/alan", binName: "dridock",
      stdout, stderr,
    },
  };
}

describe("FeaturesCommand — list", () => {
  test("bare 'features' verb defaults to list", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "features: [typescript, python]\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("enabled for this project (.dridock/config.yml → features:)");
    expect(out).toContain("  typescript\n");
    expect(out).toContain("  python\n");
    expect(out).toContain("Phase 4");   // 'available' listing still stubbed pending Docker adapter
  });

  test("empty enabled list -> the 'add e.g. …' hint", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "vm:\n  disk: 60G\n");
    const { ctx, stdout } = makeCtx(fs);
    await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["list"], ctx);
    expect(stdout.text()).toContain("(none — add e.g.");
  });

  test("no config.yml at all (fresh dir) -> still lists 0 enabled + shows .dridock name", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs, "/new-project");
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/new-project")).run(["list"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain(".dridock/config.yml"); // canonical when neither dot dir exists
  });

  test("legacy .claudebox project — dotName reflects on-disk reality", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/p/.claudebox");
    fs.seed("/p/.claudebox/config.yml", "features: [typescript]\n");
    const { ctx, stdout } = makeCtx(fs);
    await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["list"], ctx);
    expect(stdout.text()).toContain(".claudebox/config.yml");
  });
});

describe("FeaturesCommand — enable (Phase 3)", () => {
  test("enable adds a feature to an empty features:", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["enable", "typescript"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("✓ enabled feature 'typescript'");
    const cfg = await fs.readText("/p/.dridock/config.yml");
    expect(cfg).toContain("features: [typescript]");
  });

  test("enable is idempotent — 'already enabled' + no rewrite when duplicate", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [typescript]\n");
    const beforeWrites = fs.recordedWrites.length;
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["enable", "typescript"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("already enabled");
    expect(fs.recordedWrites.length).toBe(beforeWrites);   // no atomic-write fired
  });

  test("enable rejects bad names before writing", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["enable", "bad name!"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("bad name");
  });

  test("enable missing name → usage + rc 1", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["enable"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage: dridock features enable");
  });
});

describe("FeaturesCommand — disable (Phase 3)", () => {
  test("disable removes the feature; remaining list surfaced", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [typescript, python]\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["disable", "typescript"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("✓ disabled feature 'typescript'");
    expect(stdout.text()).toContain("remaining: python");
    const cfg = await fs.readText("/p/.dridock/config.yml");
    expect(cfg).toContain("features: [python]");
  });

  test("disable a feature that isn't in the list → 'nothing to disable', no write", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [python]\n");
    const beforeWrites = fs.recordedWrites.length;
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["disable", "typescript"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("nothing to disable");
    expect(fs.recordedWrites.length).toBe(beforeWrites);
  });

  test("disable the last remaining feature → block removed entirely", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nfeatures: [only]\n");
    const { ctx } = makeCtx(fs);
    await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["disable", "only"], ctx);
    const cfg = await fs.readText("/p/.dridock/config.yml");
    expect(cfg).not.toContain("features:");
    expect(cfg).toContain("id: abc");
  });
});

describe("FeaturesCommand — sub-verb dispatch", () => {
  test("info still stubbed with rc=2 (Phase 4 — needs Docker cat)", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["info", "typescript"], ctx);
    expect(rc).toBe(2);
    expect(stderr.text()).toContain("not yet ported");
  });

  test("unknown sub-verb -> DridockError rc=1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    try {
      await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as DridockError).exitCode).toBe(1);
      expect((e as Error).message).toContain("unknown sub-verb 'nonsense'");
    }
  });

  test("--help prints usage + exits 0", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run(["--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock features");
  });
});

describe("FeaturesCommand — profiles alias", () => {
  test("prints one-line deprecation notice to stderr then dispatches to features", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "features: [typescript]\n");
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new FeaturesCommand("profiles", new StubGitToplevel("/p")).run(["list"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("legacy alias");
    expect(stdout.text()).toContain("  typescript\n");
  });
});

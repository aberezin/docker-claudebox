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
    expect(out).toContain("Phase 2 stub");
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

describe("FeaturesCommand — sub-verb dispatch", () => {
  test("enable/disable/info stubbed with rc=2 + 'use bash wrapper' (Phase 2 boundary)", async () => {
    for (const sub of ["enable", "disable", "info"] as const) {
      const fs = new InMemoryFileSystem();
      const { ctx, stderr } = makeCtx(fs);
      const rc = await new FeaturesCommand("features", new StubGitToplevel("/p")).run([sub, "typescript"], ctx);
      expect(rc).toBe(2);
      expect(stderr.text()).toContain("not yet ported");
    }
  });

  test("unknown sub-verb -> DridockError rc=1 with helpful message", async () => {
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

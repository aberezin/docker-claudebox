import { test, expect, describe } from "bun:test";
import { PluginsCommand } from "./PluginsCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

/**
 * `dridock plugins` — the verb #96 shipped without (#97).
 *
 * Before this, the ONLY way to enable a per-project plugin was hand-editing
 * `.dridock/config.yml`, a gitignored file. So the feature was both
 * undiscoverable and unable to travel with a clone.
 */

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

const cmd = () => new PluginsCommand(new StubGitToplevel("/p"));
const CFG = "/p/.dridock/config.yml";
const PROJ = "/p/.dridock/project.yml";
const SPEC = "superpowers@aberezin/superpowers";

describe("plugins list", () => {
  test("bare verb defaults to list; none configured -> actionable hint", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run([], ctx)).toBe(0);
    expect(stdout.text()).toContain("(none");
    expect(stdout.text()).toContain("plugins add");
  });

  test("lists entries from the tracked project.yml with no provenance noise", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, `plugins: [${SPEC}]\n`);
    const { ctx, stdout, stderr } = makeCtx(fs);
    expect(await cmd().run(["list"], ctx)).toBe(0);
    expect(stdout.text()).toContain(SPEC);
    expect(stdout.text()).not.toContain("local only");
    expect(stderr.text()).toBe("");
  });

  test("marks a config.yml entry as local-only AND nudges on stderr", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, `id: abc\nplugins: [${SPEC}]\n`);
    const { ctx, stdout, stderr } = makeCtx(fs);
    expect(await cmd().run(["list"], ctx)).toBe(0);
    expect(stdout.text()).toContain("local only");
    expect(stderr.text()).toContain("can't travel with a clone");
  });

  test("says that these stack on the hardcoded default", async () => {
    // The additive relationship with commit-commands is the single most
    // surprising thing about the mechanism; `list` is where someone looks.
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    await cmd().run(["list"], ctx);
    expect(stdout.text()).toContain("DRIDOCK_DEFAULT_PLUGINS=0");
  });
});

describe("plugins add", () => {
  test("creates the tracked project.yml and leaves config.yml untouched", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run(["add", SPEC], ctx)).toBe(0);
    expect(await fs.readText(PROJ)).toContain(`plugins: [${SPEC}]`);
    const cfg = await fs.readText(CFG);
    expect(cfg).not.toContain("plugins:");
    expect(cfg).toContain("id: abc");
    expect(stdout.text()).toContain("commit it");
  });

  test("appends without clobbering an existing entry", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, "plugins: [first@o/r]\n");
    const { ctx } = makeCtx(fs);
    await cmd().run(["add", SPEC], ctx);
    const text = await fs.readText(PROJ);
    expect(text).toContain("first@o/r");
    expect(text).toContain(SPEC);
  });

  test("idempotent — already present is a no-op success", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, `plugins: [${SPEC}]\n`);
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run(["add", SPEC], ctx)).toBe(0);
    expect(stdout.text()).toContain("already enabled");
  });

  test("already present in the LEGACY file also counts as present", async () => {
    // Otherwise `add` would write a project.yml duplicate of something that
    // is already installing, and the union would show it twice.
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, `plugins: [${SPEC}]\n`);
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run(["add", SPEC], ctx)).toBe(0);
    expect(stdout.text()).toContain("already enabled");
    expect(await fs.readTextOrUndefined(PROJ)).toBeUndefined();
  });

  test("rejects the #96 injection payload, rc 1, writes nothing", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    const { ctx, stderr } = makeCtx(fs);
    expect(await cmd().run(["add", "x@a/b';touch /tmp/INJECTED;'"], ctx)).toBe(1);
    expect(stderr.text()).toContain("bad spec");
    expect(await fs.readTextOrUndefined(PROJ)).toBeUndefined();
  });

  test("rejects a version-pinned spec and says why", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    const { ctx, stderr } = makeCtx(fs);
    expect(await cmd().run(["add", `${SPEC}@v7.0.2`], ctx)).toBe(1);
    expect(stderr.text()).toContain("no version component");
  });

  test("missing argument -> usage, rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    expect(await cmd().run(["add"], ctx)).toBe(1);
    expect(stderr.text()).toContain("usage: dridock plugins add");
  });
});

describe("plugins remove", () => {
  test("removes from project.yml", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, `plugins: [${SPEC}, other@o/r]\n`);
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run(["remove", SPEC], ctx)).toBe(0);
    const text = await fs.readText(PROJ);
    expect(text).not.toContain(SPEC);
    expect(text).toContain("other@o/r");
    expect(stdout.text()).toContain("remaining: other@o/r");
  });

  test("ALSO clears the legacy config.yml copy", async () => {
    // The silent-no-op guard: reads are a union, so dropping the entry from
    // project.yml alone would report success while config.yml kept installing
    // it. Delete the config.yml branch in PluginsCommand.remove and this is
    // the test that fails.
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, `id: abc\nplugins: [${SPEC}]\n`);
    fs.seed(PROJ, `plugins: [${SPEC}]\n`);
    const { ctx } = makeCtx(fs);
    expect(await cmd().run(["remove", SPEC], ctx)).toBe(0);
    expect(await fs.readText(PROJ)).not.toContain(SPEC);
    expect(await fs.readText(CFG)).not.toContain(SPEC);
    expect(await fs.readText(CFG)).toContain("id: abc");
  });

  test("removes a config.yml-only entry without creating project.yml", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, `id: abc\nplugins: [${SPEC}]\n`);
    const { ctx } = makeCtx(fs);
    expect(await cmd().run(["remove", SPEC], ctx)).toBe(0);
    expect(await fs.readText(CFG)).not.toContain(SPEC);
    expect(await fs.readTextOrUndefined(PROJ)).toBeUndefined();
  });

  test("not present -> says so, rc 0, nothing written", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(CFG, "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run(["remove", SPEC], ctx)).toBe(0);
    expect(stdout.text()).toContain("nothing to remove");
  });

  test("is honest that an installed copy stays installed", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed(PROJ, `plugins: [${SPEC}]\n`);
    const { ctx, stdout } = makeCtx(fs);
    await cmd().run(["remove", SPEC], ctx);
    expect(stdout.text()).toContain("plugin uninstall");
  });

  test("missing argument -> usage, rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    expect(await cmd().run(["remove"], ctx)).toBe(1);
    expect(stderr.text()).toContain("usage: dridock plugins remove");
  });
});

describe("plugins dispatch", () => {
  test("--help prints the sub-verbs", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    expect(await cmd().run(["--help"], ctx)).toBe(0);
    for (const v of ["list", "add", "remove"]) expect(stdout.text()).toContain(v);
  });

  test("unknown sub-verb throws a DridockError naming it", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    let err: unknown;
    try { await cmd().run(["nonsense"], ctx); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DridockError);
    expect((err as Error).message).toContain("nonsense");
  });

  test("every declared subverb has a mini-usage synopsis", () => {
    for (const sv of new PluginsCommand().subverbs) {
      expect(sv.synopsis).toContain(`dridock plugins ${sv.name}`);
      expect(sv.synopsis.length).toBeGreaterThan(30);
    }
  });
});

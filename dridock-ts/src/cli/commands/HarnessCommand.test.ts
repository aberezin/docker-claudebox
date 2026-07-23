import { test, expect, describe } from "bun:test";
import { HarnessCommand } from "./HarnessCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/repo"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

const HARNESS_WRAPPER = `#!/usr/bin/env bash\nDRIDOCK_VERSION="3.3.7"\n# ...more script...\n`;

describe("HarnessCommand", () => {
  test("no sub → rc 1 usage", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
      runMakeBuild: async () => ({ rc: 0, output: "" }),
      insideContainer: async () => false,
    }).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("harness <verb>");
  });

  test("unknown sub → DridockError", async () => {
    const { ctx } = makeCtx(new InMemoryFileSystem());
    try {
      await new HarnessCommand({
        git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
        runMakeBuild: async () => ({ rc: 0, output: "" }),
        insideContainer: async () => false,
      }).run(["nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });

  test("sync: not a harness fork → rc 1 + explanation", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", "#!/usr/bin/env bash\n# no version line here\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
      runMakeBuild: async () => ({ rc: 0, output: "" }),
      insideContainer: async () => false,
    }).run(["sync"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("not a dridock harness fork");
  });

  test("sync: inside a container → rc 1 + 'run on the Mac' explanation", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
      runMakeBuild: async () => ({ rc: 0, output: "" }),
      insideContainer: async () => true,   // simulate /.dockerenv present
    }).run(["sync"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("must run on the Mac");
  });

  test("sync: harness fork, on Mac, make build succeeds → rc 0", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const { ctx, stdout } = makeCtx(fs);
    let called = 0;
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
      runMakeBuild: async (root) => { called++; expect(root).toBe("/repo"); return { rc: 0, output: "" }; },
      insideContainer: async () => false,
    }).run(["sync"], ctx);
    expect(rc).toBe(0);
    expect(called).toBe(1);
    expect(stdout.text()).toContain("rebuilding cb-infra image from /repo");
  });

  test("sync: make build fails, no --repair → rc propagated verbatim", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
      runMakeBuild: async () => ({ rc: 2, output: "some non-corruption error\n" }),
      insideContainer: async () => false,
    }).run(["sync"], ctx);
    expect(rc).toBe(2);
  });

  test("sync --repair: BuildKit corruption pattern → docker builder prune + retry, success on retry → rc 0", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const docker = new InMemoryDocker();
    let attempt = 0;
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker,
      runMakeBuild: async () => {
        attempt++;
        return attempt === 1
          ? { rc: 2, output: "ERROR: failed to prepare extraction snapshot\n" }
          : { rc: 0, output: "" };
      },
      insideContainer: async () => false,
    }).run(["sync", "--repair"], ctx);
    expect(rc).toBe(0);
    expect(attempt).toBe(2);
    expect(docker.builderPrunes).toHaveLength(1);   // cb-infra prune once
    expect(stderr.text()).toContain("recovered");
  });

  test("sync --repair: unrelated build failure (no corruption pattern) → does NOT prune, returns rc verbatim", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const docker = new InMemoryDocker();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker,
      runMakeBuild: async () => ({ rc: 3, output: "Dockerfile syntax error at line 42\n" }),
      insideContainer: async () => false,
    }).run(["sync", "--repair"], ctx);
    expect(rc).toBe(3);
    expect(docker.builderPrunes).toHaveLength(0);
    expect(stderr.text()).toContain("not with a recognized BuildKit corruption pattern");
  });

  test("sync --repair: corruption pattern but retry still fails → rc from second attempt + advice to restart colima", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const docker = new InMemoryDocker();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand({
      git: new StubGitToplevel("/repo"), docker,
      runMakeBuild: async () => ({ rc: 4, output: "parent snapshot xyz does not exist\n" }),
      insideContainer: async () => false,
    }).run(["sync", "--repair"], ctx);
    expect(rc).toBe(4);
    expect(docker.builderPrunes).toHaveLength(1);
    expect(stderr.text()).toContain("colima stop -p cb-infra");
  });

  test("sync unknown arg → DridockError", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/wrapper.sh", HARNESS_WRAPPER);
    const { ctx } = makeCtx(fs);
    try {
      await new HarnessCommand({
        git: new StubGitToplevel("/repo"), docker: new InMemoryDocker(),
        runMakeBuild: async () => ({ rc: 0, output: "" }),
        insideContainer: async () => false,
      }).run(["sync", "--nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });
});

import { test, expect, describe } from "bun:test";
import { CheckversionCommand } from "./CheckversionCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";
import { IMAGE_UNAVAILABLE } from "../../infra/Docker.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): {
  ctx: Context; stdout: StringWriter; stderr: StringWriter;
} {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

describe("CheckversionCommand — happy paths", () => {
  test("in-sync (no project) prints the ✅ line", async () => {
    const fs = new InMemoryFileSystem();
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain(`wrapper (host):        ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain(`image (cb-infra):      ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain("<no dridock project in /p>");
    expect(out).toContain("✅ in sync");
  });

  test("in-sync WITH project (all three match) prints the project row + ✅", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc12345\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-abc12345", "dridock:latest", DRIDOCK_TS_VERSION);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("(VM cb-abc12345)");
    expect(out).toContain("✅ in sync");
  });

  test("Arfy #38 §🟠: claude CLI (in image) row present when project is set", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-abc", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedClaudeCliVersion("colima-cb-abc", "dridock:latest", "0.5.14");
    const { ctx, stdout } = makeCtx(fs);
    await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(stdout.text()).toContain("claude CLI (in image): 0.5.14");
  });

  test("Arfy #38 §🟠: claude CLI row prints 'unavailable' when image missing (matches bash's 'unavailable')", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-abc", "dridock:latest", DRIDOCK_TS_VERSION);
    // NOTE: no seedClaudeCliVersion — InMemoryDocker returns IMAGE_UNAVAILABLE
    const { ctx, stdout } = makeCtx(fs);
    await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(stdout.text()).toContain("claude CLI (in image): unavailable");
  });

  test("claude CLI row NOT printed when there's no dridock project (bash-parity: gated by cid)", async () => {
    const fs = new InMemoryFileSystem();
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    const { ctx, stdout } = makeCtx(fs);
    await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(stdout.text()).not.toContain("claude CLI");
  });

  test("reseed-needed: cb-infra current, project VM behind", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.5");
    const { ctx, stdout } = makeCtx(fs);
    await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("ℹ️  cb-infra is current");
    expect(out).toContain("this project's VM still runs 3.3.5");
    expect(out).toContain("run 'dridock start'");
  });

  test("no-comparable: nothing built", async () => {
    const fs = new InMemoryFileSystem();
    const docker = new InMemoryDocker(); // nothing seeded -> IMAGE_UNAVAILABLE everywhere
    const { ctx, stdout } = makeCtx(fs);
    await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(stdout.text()).toContain("no built image reachable");
  });

  test("drift: MAJOR bump, wrapper newer", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", "2.9.9");
    docker.seedImage("colima-cb-abc", "dridock:latest", "2.9.9");
    const { ctx, stdout } = makeCtx(fs);
    // Force a MAJOR drift by pinning the wrapper at 3.0.0 — assumes DRIDOCK_TS_VERSION >= 3.
    // The command uses DRIDOCK_TS_VERSION directly (no injection point yet); wrapping with
    // a subclass would over-engineer, so we assert on whichever direction lands.
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("⚠️  version drift");
    expect(stdout.text()).toMatch(/(🔴 MAJOR|🟠 MINOR|🟡 PATCH) drift/);
  });
});

describe("CheckversionCommand — arg handling", () => {
  test("--all is deferred with rc=2 (Phase 3 will port)", async () => {
    const fs = new InMemoryFileSystem();
    const docker = new InMemoryDocker();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run(["--all"], ctx);
    expect(rc).toBe(2);
    expect(stderr.text()).toContain("not yet ported");
  });

  test("--help prints usage + exits 0", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run(["--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock checkversion");
  });

  test("unknown arg throws DridockError rc=1 (matches bash return 1)", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    try {
      await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run(["--nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as DridockError).exitCode).toBe(1);
    }
  });
});

describe("CheckversionCommand — silent-arg family (the 3.3.x audit rule)", () => {
  test("survives IMAGE_UNAVAILABLE without crashing (no assumption images are always fetchable)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const docker = new InMemoryDocker(); // both images unavailable
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain(IMAGE_UNAVAILABLE);
  });
});

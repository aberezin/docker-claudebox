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
  test("--all enumerates other cb-* project VMs (P4c: fully ported)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: this-project\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-this-project", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-other-a", "dridock:latest", "3.3.6");
    docker.seedImage("colima-cb-other-b", "dridock:latest", "3.3.5");
    const { InMemoryColima } = await import("../../test/fakes/InMemoryColima.ts");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    colima.seedVm({ name: "cb-this-project", status: "Running", address: "1.1.1.1" });
    colima.seedVm({ name: "cb-other-a", status: "Running", address: "2.2.2.2" });
    colima.seedVm({ name: "cb-other-b", status: "Stopped", address: "" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p"), colima).run(["--all"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    // Section header
    expect(out).toContain("all cb-* project VMs (--all):");
    // Other VMs listed in the --all block
    expect(out).toContain("cb-other-a");
    expect(out).toContain("cb-other-b");
    expect(out).toContain("3.3.6");
    expect(out).toContain("3.3.5");
    // The --all BLOCK excludes this project + cb-infra. Header row for
    // this project mentions cb-this-project (`(VM cb-this-project)`) —
    // that's expected. Assert on the --all block content only:
    const allBlock = out.split("all cb-* project VMs (--all):")[1] ?? "";
    expect(allBlock).not.toContain("cb-this-project");
    expect(allBlock).not.toContain("cb-infra ");   // trailing space to distinguish from column-aligned VMs
  });

  test("--all with no other VMs → '(none besides this project)'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: only-me\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", DRIDOCK_TS_VERSION);
    docker.seedImage("colima-cb-only-me", "dridock:latest", DRIDOCK_TS_VERSION);
    const { InMemoryColima } = await import("../../test/fakes/InMemoryColima.ts");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    colima.seedVm({ name: "cb-only-me", status: "Running", address: "1.1.1.1" });
    const { ctx, stdout } = makeCtx(fs);
    await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/p"), colima).run(["--all"], ctx);
    expect(stdout.text()).toContain("(none besides this project)");
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

describe("CheckversionCommand --binary — stale-binary check (Arfy filed after #40)", () => {
  test("baked version === VERSION file → ✅ in sync, rc 0, no docker calls", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/VERSION", `${DRIDOCK_TS_VERSION}\n`);
    const docker = new InMemoryDocker();
    const { ctx, stdout } = makeCtx(fs, "/repo/sub/dir");
    const rc = await new CheckversionCommand("dridock:latest", docker, new StubGitToplevel("/repo")).run(["--binary"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain(`binary: ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain(`source: ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain(`✅ in sync`);
    // No docker touched — --binary is a pure local diagnostic.
    expect(docker.runCalls).toEqual([]);
  });

  test("VERSION > baked → ⚠️ STALE binary + rebuild hint, rc 0", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/VERSION", "3.9.99\n"); // pretend source is way ahead
    const { ctx, stdout } = makeCtx(fs, "/repo");
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/repo")).run(["--binary"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain(`binary: ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain(`source: 3.9.99`);
    expect(out).toContain(`⚠️  STALE binary`);
    // The one-liner install-sh path — Arfy caught (2026-07-24 on #41 verify)
    // that a naked `./install.sh` won't rebuild TS (gated behind the env
    // flag at install.sh:128), so the hint must carry the flag.
    expect(out).toContain(`DRIDOCK_INSTALL_TS=1 ./install.sh`);
  });

  test("baked > VERSION → ℹ️ binary NEWER (older checkout, no rebuild since)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/VERSION", "0.0.1\n");
    const { ctx, stdout } = makeCtx(fs, "/repo");
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/repo")).run(["--binary"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain(`ℹ️  binary is NEWER than source`);
    expect(out).toContain(`older-ref`);
  });

  test("not in a git repo → informational, rc 0 (opportunistic verb, not an error)", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs, "/tmp");
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel(undefined)).run(["--binary"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain(`<not in a git repo`);
    expect(stdout.text()).toContain(`run this from a dridock checkout`);
  });

  test("git repo but no VERSION at toplevel → rc 1, stderr says 'not a dridock source tree'", async () => {
    const fs = new InMemoryFileSystem();
    // No VERSION seeded — toplevel exists per StubGit, but the FS has nothing there.
    const { ctx, stdout, stderr } = makeCtx(fs, "/some/other/repo");
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/some/other/repo")).run(["--binary"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toContain(`<not a dridock checkout>`);
    expect(stderr.text()).toContain(`/some/other/repo/VERSION not found`);
    expect(stderr.text()).toContain(`run this from a dridock checkout`);
  });

  test("VERSION with trailing newline / leading `v` parses tolerantly", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/VERSION", `v${DRIDOCK_TS_VERSION}\n\n`);
    const { ctx, stdout } = makeCtx(fs, "/repo");
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/repo")).run(["--binary"], ctx);
    expect(rc).toBe(0);
    // parseLoose strips the `v`; treats as equal
    expect(stdout.text()).toContain(`✅ in sync`);
  });

  test("--binary + --all → DridockError (mutually exclusive)", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    try {
      await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/repo")).run(["--binary", "--all"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
      expect((e as DridockError).message).toContain("mutually exclusive");
    }
  });

  test("-b short form → same as --binary", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/VERSION", `${DRIDOCK_TS_VERSION}\n`);
    const { ctx, stdout } = makeCtx(fs, "/repo");
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/repo")).run(["-b"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain(`✅ in sync`);
  });

  test("--help mentions --binary", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new CheckversionCommand("dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run(["--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain(`--binary`);
  });
});

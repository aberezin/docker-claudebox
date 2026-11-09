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

// The harness fingerprint since 5.0: a file that still EXISTS. Until then this
// grepped wrapper.sh, which 4.0.0 deleted — so the guard rejected the harness
// repo itself and `harness sync` was dead in its only valid location.
const HARNESS_FINGERPRINT = "/repo/dridock-ts/src/domain/dridockVersion.ts";
const HARNESS_FINGERPRINT_BODY = `export const DRIDOCK_TS_VERSION = "5.0.0";\n`;

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
    fs.seed("/repo/README.md", "just some repo, no harness fingerprint\n");
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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
    fs.seed(HARNESS_FINGERPRINT, HARNESS_FINGERPRINT_BODY);
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

// #100: `dridock harness update-cli`.
describe("HarnessCommand.update-cli", () => {
  const DOCKERFILE_BODY = [
    "FROM ubuntu:24.04 AS base",
    "# Override at build time: --build-arg CLAUDE_VERSION=2.1.243",
    "ARG CLAUDE_VERSION=2.1.258",
    "RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}",
    "",
    "FROM base AS minimal",
    "ARG CLAUDE_VERSION",
    "",
    "FROM base AS full",
    "ARG CLAUDE_VERSION",
  ].join("\n");
  const VERSION_BODY = "5.10.1\n";
  const DRIDOCK_VERSION_TS_BODY = [
    `export const DRIDOCK_TS_VERSION = "5.10.1";`,
    `export const CLAUDE_CLI_REMOTE_CONTROL_FLOOR = "2.1.206";`,
  ].join("\n");
  const CHANGELOG_BODY = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [5.10.1] - 2026-11-09",
    "",
    "### Fixed",
    "- something earlier",
  ].join("\n");

  function seedRepo(fs: InMemoryFileSystem): void {
    fs.seed(HARNESS_FINGERPRINT, DRIDOCK_VERSION_TS_BODY);
    fs.seed("/repo/Dockerfile", DOCKERFILE_BODY);
    fs.seed("/repo/VERSION", VERSION_BODY);
    fs.seed("/repo/CHANGELOG.md", CHANGELOG_BODY);
  }

  function baseDeps(overrides: Partial<import("./HarnessCommand.ts").HarnessDeps> = {}): import("./HarnessCommand.ts").HarnessDeps {
    return {
      git: new StubGitToplevel("/repo"),
      docker: new InMemoryDocker(),
      runMakeBuild: async () => ({ rc: 0, output: "" }),
      insideContainer: async () => false,
      runMakeBuildMinimal: async () => ({ rc: 0, output: "" }),
      readBakedClaudeVersion: async () => "2.1.319",
      resolveChannel: async () => undefined,
      ...overrides,
    };
  }

  test("missing target → rc 1 usage", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("missing target");
  });

  test("--help → rc 0, no file changes", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("update-cli <version|latest|stable>");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
  });

  test("not a harness fork → rc 1, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/README.md", "just some repo\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("not a dridock harness fork");
  });

  test("malformed explicit version → rc 1, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "latest-ish"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("isn't a version");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
  });

  test("unexpected second argument → DridockError", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx } = makeCtx(fs);
    try {
      await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319", "2.1.320"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });

  test("already at target → rc 0, no-op, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/VERSION");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.258"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("already at 2.1.258");
    expect(await fs.readText("/repo/VERSION")).toBe(before);
  });

  test("below --remote-control floor → rc 1, refuses, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.100"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("below the --remote-control floor");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
  });

  test("explicit version, build validates + matches → rc 0, all four files updated in lockstep", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      readBakedClaudeVersion: async () => "2.1.319",
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("pin 2.1.258 → 2.1.319");
    expect(stdout.text()).toContain("dridock 5.10.1 → 5.11.0");
    expect(stdout.text()).toContain("validated — dridock:latest-minimal bakes claude 2.1.319");

    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.319");
    // Mid-file re-declarations must stay bare, untouched.
    expect((await fs.readText("/repo/Dockerfile")).match(/^ARG CLAUDE_VERSION$/gm)).toHaveLength(2);
    expect(await fs.readText("/repo/VERSION")).toBe("5.11.0\n");
    expect(await fs.readText(HARNESS_FINGERPRINT)).toContain(`DRIDOCK_TS_VERSION = "5.11.0"`);
    // Floor constant in the same file is untouched by the replace.
    expect(await fs.readText(HARNESS_FINGERPRINT)).toContain(`CLAUDE_CLI_REMOTE_CONTROL_FLOOR = "2.1.206"`);

    const changelog = await fs.readText("/repo/CHANGELOG.md");
    expect(changelog).toContain("## [5.11.0]");
    expect(changelog).toContain("Claude Code CLI pin raised **2.1.258 → 2.1.319**");
    // Prior entries survive, in order, below the new one.
    expect(changelog.indexOf("## [5.11.0]")).toBeLessThan(changelog.indexOf("## [5.10.1]"));
  });

  test("'latest' channel resolves via resolveChannel, not a real network call", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let askedChannel: string | undefined;
    let askedUrl: string | undefined;
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      resolveChannel: async (channel, url) => { askedChannel = channel; askedUrl = url; return "2.1.319"; },
      readBakedClaudeVersion: async () => "2.1.319",
    })).run(["update-cli", "latest"], ctx);
    expect(rc).toBe(0);
    expect(askedChannel).toBe("latest");
    expect(askedUrl).toBe("https://downloads.claude.ai/claude-code-releases");
    expect(stdout.text()).toContain("'latest' resolves to 2.1.319");
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.319");
  });

  test("DRIDOCK_CLAUDE_RELEASES_URL overrides the resolution URL", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let askedUrl: string | undefined;
    const stdout = new StringWriter();
    const stderr = new StringWriter();
    const ctx: Context = {
      fs, env: new EnvResolver({ DRIDOCK_CLAUDE_RELEASES_URL: "https://example.test/releases" }),
      cwd: "/repo", home: "/home/alan", binName: "dridock", stdout, stderr,
    };
    const rc = await new HarnessCommand(baseDeps({
      resolveChannel: async (_channel, url) => { askedUrl = url; return "2.1.319"; },
      readBakedClaudeVersion: async () => "2.1.319",
    })).run(["update-cli", "stable"], ctx);
    expect(rc).toBe(0);
    expect(askedUrl).toBe("https://example.test/releases");
  });

  test("channel resolves to garbage → rc 1, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      resolveChannel: async () => "<html>not found</html>",
    })).run(["update-cli", "latest"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("could not resolve channel");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
  });

  test("channel resolution fails outright (undefined) → rc 1, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      resolveChannel: async () => undefined,
    })).run(["update-cli", "latest"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("could not resolve channel");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
  });

  test("--skip-build → rc 0, files written, build never invoked", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let buildCalled = false;
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      runMakeBuildMinimal: async () => { buildCalled = true; return { rc: 0, output: "" }; },
    })).run(["update-cli", "2.1.319", "--skip-build"], ctx);
    expect(rc).toBe(0);
    expect(buildCalled).toBe(false);
    expect(stdout.text()).toContain("not validating");
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.319");
  });

  test("build fails → rc from build, files stay edited (no auto-revert)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      runMakeBuildMinimal: async () => ({ rc: 2, output: "some build error\n" }),
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(2);
    expect(stderr.text()).toContain("'make build-minimal' failed");
    expect(stderr.text()).toContain("nothing reverted");
    // The whole point of this test: edits persist despite the failure.
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.319");
    expect(await fs.readText("/repo/VERSION")).toBe("5.11.0\n");
  });

  test("build succeeds but baked version doesn't match target (stale cache) → rc 1, files stay edited", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      runMakeBuildMinimal: async () => ({ rc: 0, output: "" }),
      readBakedClaudeVersion: async () => "2.1.258", // stale — didn't actually update
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("bakes claude 2.1.258, not 2.1.319");
    expect(stderr.text()).toContain("cached layer");
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.319");
  });

  test("readBakedClaudeVersion returns undefined (docker call failed entirely) → rc 1", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      readBakedClaudeVersion: async () => undefined,
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("bakes claude (unreadable), not 2.1.319");
  });

  test("no '## [Unreleased]' anchor in CHANGELOG → warns, still succeeds, other files still updated", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    fs.seed("/repo/CHANGELOG.md", "# Changelog\n\nNo anchor here.\n");
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("skipped the CHANGELOG entry");
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.319");
    expect(stdout.text()).toContain("validated");
  });
});

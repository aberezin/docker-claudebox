import { test, expect, describe } from "bun:test";
import { HarnessCommand } from "./HarnessCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/repo", env: Record<string, string | undefined> = {}): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver(env), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
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
      // Default: HEAD matches whatever seedRepo() put on disk — i.e. every
      // pre-#101-F3 test is a "fresh" iteration (no prior uncommitted bump),
      // matching their pre-F3 expectations. F3's own tests override this to
      // simulate a prior uncommitted update-cli run.
      readFileAtHead: async (_root, relativePath) => {
        if (relativePath === "VERSION") return VERSION_BODY;
        if (relativePath === "Dockerfile") return DOCKERFILE_BODY;
        return undefined;
      },
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

  test("#106: '## [Unreleased]' missing but release headings present → heading restored above the first one, entry written, said on stderr", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    // The shape a release cut leaves when it renames the heading instead of
    // adding one above it -- what 5.13.0 did.
    fs.seed("/repo/CHANGELOG.md", "# Changelog\n\nPreamble.\n\n## [5.10.1] - 2026-11-09\n\n### Fixed\n- something earlier\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    const out = await fs.readText("/repo/CHANGELOG.md");
    expect(stderr.text()).toContain("added it above the first release heading");
    expect(stderr.text()).not.toContain("skipped the CHANGELOG entry");
    // Exactly one heading, above the new entry, above the old release; the
    // preamble and the old release are untouched.
    expect(out.match(/^## \[Unreleased\]$/gm)).toHaveLength(1);
    const iUnrel = out.indexOf("## [Unreleased]");
    const iNew = out.indexOf("## [5.11.0]");
    const iOld = out.indexOf("## [5.10.1] - 2026-11-09");
    expect(iUnrel).toBeGreaterThan(out.indexOf("Preamble."));
    expect(iUnrel).toBeLessThan(iNew);
    expect(iNew).toBeLessThan(iOld);
    expect(out).toContain("Claude Code CLI pin raised **");
    expect(out.endsWith("### Fixed\n- something earlier\n")).toBe(true);
  });

  test("#106: heading with trailing whitespace counts as present — entry written under it, no second heading stacked (Arfy's nit)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    fs.seed("/repo/CHANGELOG.md", "# Changelog\n\n## [Unreleased]  \n\n## [5.10.1] - 2026-11-09\n\n### Fixed\n- something earlier\n");
    const { ctx, stderr } = makeCtx(fs);
    expect(await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319"], ctx)).toBe(0);
    const out = await fs.readText("/repo/CHANGELOG.md");
    expect(out.match(/^## \[Unreleased\]/gm)).toHaveLength(1);
    expect(out).toContain("Claude Code CLI pin raised **");
    expect(out.indexOf("## [5.11.0]")).toBeGreaterThan(out.indexOf("## [Unreleased]"));
    expect(stderr.text()).not.toContain("skipped the CHANGELOG entry");
    expect(stderr.text()).not.toContain("added it above");
  });

  test("#106: heading present → no 'added' note (the restore path stays out of the normal case)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stderr } = makeCtx(fs);
    expect(await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319"], ctx)).toBe(0);
    expect(stderr.text()).not.toContain("had no '## [Unreleased]' heading");
    expect((await fs.readText("/repo/CHANGELOG.md")).match(/^## \[Unreleased\]$/gm)).toHaveLength(1);
  });

  // --- F1 (Arfy, #100): the validation read-back must query the SAME
  // daemon + image `make build-minimal` just built, not whatever the
  // operator's ambient docker context happens to be. ---

  test("F1: inside a container (docker backend) → read-back uses bare docker args, no --context", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let gotArgs: readonly string[] | undefined;
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      insideContainer: async () => true,
      readBakedClaudeVersion: async (_image, dockerArgs) => { gotArgs = dockerArgs; return "2.1.319"; },
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(gotArgs).toEqual([]);
  });

  test("F1: not inside a container (colima backend) → read-back uses --context colima-cb-infra", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let gotArgs: readonly string[] | undefined;
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      insideContainer: async () => false,
      readBakedClaudeVersion: async (_image, dockerArgs) => { gotArgs = dockerArgs; return "2.1.319"; },
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(gotArgs).toEqual(["--context", "colima-cb-infra"]);
  });

  test("F1: explicit DRIDOCK_BACKEND=docker wins over insideContainer()=false (mirrors Makefile's ?=)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let gotArgs: readonly string[] | undefined;
    const { ctx } = makeCtx(fs, "/repo", { DRIDOCK_BACKEND: "docker" });
    const rc = await new HarnessCommand(baseDeps({
      insideContainer: async () => false, // would normally mean colima — the env override wins
      readBakedClaudeVersion: async (_image, dockerArgs) => { gotArgs = dockerArgs; return "2.1.319"; },
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(gotArgs).toEqual([]);
  });

  test("F1: IMAGE_NAME/TAG env vars change the queried image, mirroring the Makefile's own overrides", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    let gotImage: string | undefined;
    const { ctx, stdout } = makeCtx(fs, "/repo", { IMAGE_NAME: "myfork", TAG: "dev" });
    const rc = await new HarnessCommand(baseDeps({
      readBakedClaudeVersion: async (image) => { gotImage = image; return "2.1.319"; },
    })).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(gotImage).toBe("myfork:dev-minimal");
    expect(stdout.text()).toContain("validated — myfork:dev-minimal bakes claude 2.1.319");
  });

  // --- F2 (Arfy, #100): the floor guard alone let 'stable' silently
  // regress behind an already-newer 'latest' pin, reported as "raised". ---

  test("F2: target older than current pin, no --allow-downgrade → rc 1, refuses, no files touched", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs); // current pin 2.1.258
    fs.seed("/repo/Dockerfile", DOCKERFILE_BODY.replace("2.1.258", "2.1.300")); // current pin now 2.1.300
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.280"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("OLDER than the current pin 2.1.300");
    expect(stderr.text()).toContain("--allow-downgrade");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
    expect(await fs.readText("/repo/VERSION")).toBe(VERSION_BODY);
  });

  test("F2: 'stable' resolving behind the current pin → refused (the exact scenario Arfy reproduced)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    fs.seed("/repo/Dockerfile", DOCKERFILE_BODY.replace("2.1.258", "2.1.319")); // current pin: latest already applied
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      resolveChannel: async () => "2.1.311", // stable trails latest
    })).run(["update-cli", "stable"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("OLDER than the current pin 2.1.319");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
  });

  test("F2: target older than current pin WITH --allow-downgrade → succeeds, CHANGELOG says 'lowered'", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    fs.seed("/repo/Dockerfile", DOCKERFILE_BODY.replace("2.1.258", "2.1.300"));
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      readBakedClaudeVersion: async () => "2.1.280",
    })).run(["update-cli", "2.1.280", "--allow-downgrade"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("pin 2.1.300 → 2.1.280");
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.280");
    const changelog = await fs.readText("/repo/CHANGELOG.md");
    expect(changelog).toContain("Claude Code CLI pin lowered **2.1.300 → 2.1.280**");
  });

  test("F2: downgrade below the --remote-control floor → floor guard fires first regardless of --allow-downgrade", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    fs.seed("/repo/Dockerfile", DOCKERFILE_BODY.replace("2.1.258", "2.1.300"));
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.100", "--allow-downgrade"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("below the --remote-control floor");
  });

  // --- N1/N2 (Arfy, #100 sign-off nits) ---

  test("N1: --skip-build hint uses the SAME computed image/context as the real validation would", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stdout } = makeCtx(fs, "/repo", { DRIDOCK_BACKEND: "colima", IMAGE_NAME: "myfork", TAG: "dev" });
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319", "--skip-build"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("docker --context colima-cb-infra run --rm --entrypoint claude myfork:dev-minimal --version");
  });

  test("N1: --skip-build hint is bare (no --context) on the docker backend", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stdout } = makeCtx(fs, "/repo", { DRIDOCK_BACKEND: "docker" });
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319", "--skip-build"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("docker run --rm --entrypoint claude dridock:latest-minimal --version");
    expect(stdout.text()).not.toContain("--context");
  });

  test("N2: invalid DRIDOCK_BACKEND value → rc 1, refuses loudly, no files touched (never silently falls to auto-detect)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const before = await fs.readText("/repo/Dockerfile");
    const { ctx, stderr } = makeCtx(fs, "/repo", { DRIDOCK_BACKEND: "podman" });
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("DRIDOCK_BACKEND='podman'");
    expect(stderr.text()).toContain("isn't 'docker' or 'colima'");
    expect(await fs.readText("/repo/Dockerfile")).toBe(before);
    expect(await fs.readText("/repo/VERSION")).toBe(VERSION_BODY);
  });

  test("N2: invalid DRIDOCK_BACKEND is refused even under --skip-build (the value is wrong regardless of whether it's used for a real docker call)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    const { ctx, stderr } = makeCtx(fs, "/repo", { DRIDOCK_BACKEND: "podman" });
    const rc = await new HarnessCommand(baseDeps()).run(["update-cli", "2.1.319", "--skip-build"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("DRIDOCK_BACKEND='podman'");
  });

  // --- F3 (#101): idempotency across repeated different targets ---

  /** Simulate the on-disk state right after a PRIOR, uncommitted
   *  `update-cli stable` run resolved to 2.1.300 (first iteration), while
   *  HEAD (what's actually committed) is still at the original seedRepo()
   *  state (pin 2.1.258, dridock 5.10.1). */
  function seedPriorUncommittedIteration(fs: InMemoryFileSystem): void {
    seedRepo(fs);
    fs.seed("/repo/Dockerfile", DOCKERFILE_BODY.replace("2.1.258", "2.1.300"));
    fs.seed("/repo/VERSION", "5.11.0\n");
    fs.seed(HARNESS_FINGERPRINT, DRIDOCK_VERSION_TS_BODY.replace("5.10.1", "5.11.0"));
    fs.seed(
      "/repo/CHANGELOG.md",
      CHANGELOG_BODY.replace(
        "## [Unreleased]\n",
        "## [Unreleased]\n\n## [5.11.0] - 2026-11-09\n\n### Changed\n- Claude Code CLI pin raised **2.1.258 → 2.1.300** (`ARG CLAUDE_VERSION`), resolved from the `stable` release channel. Above the `--remote-control` floor (2.1.206).\n",
      ),
    );
  }

  /** HEAD never moved in this scenario — it's still exactly seedRepo()'s
   *  original state, regardless of what's now on disk. */
  function depsWithHeadAtSeedRepo(overrides: Partial<import("./HarnessCommand.ts").HarnessDeps> = {}): import("./HarnessCommand.ts").HarnessDeps {
    return baseDeps({
      readFileAtHead: async (_root, relativePath) => {
        if (relativePath === "VERSION") return VERSION_BODY;
        if (relativePath === "Dockerfile") return DOCKERFILE_BODY;
        return undefined;
      },
      ...overrides,
    });
  }

  test("F3: a second iteration with a different target reuses the prior uncommitted VERSION bump instead of stacking another", async () => {
    const fs = new InMemoryFileSystem();
    seedPriorUncommittedIteration(fs);
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(depsWithHeadAtSeedRepo({
      readBakedClaudeVersion: async () => "2.1.320",
    })).run(["update-cli", "2.1.320"], ctx);
    expect(rc).toBe(0);
    // Dockerfile always reflects the LATEST target.
    expect(await fs.readText("/repo/Dockerfile")).toContain("ARG CLAUDE_VERSION=2.1.320");
    // VERSION is REUSED (still 5.11.0), not bumped again to 5.12.0.
    expect(await fs.readText("/repo/VERSION")).toBe("5.11.0\n");
    expect(await fs.readText(HARNESS_FINGERPRINT)).toContain(`DRIDOCK_TS_VERSION = "5.11.0"`);
  });

  test("F3: the CHANGELOG entry is replaced in place, not stacked, and describes the CUMULATIVE change since HEAD", async () => {
    const fs = new InMemoryFileSystem();
    seedPriorUncommittedIteration(fs);
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(depsWithHeadAtSeedRepo({
      readBakedClaudeVersion: async () => "2.1.320",
    })).run(["update-cli", "2.1.320"], ctx);
    expect(rc).toBe(0);
    const changelog = await fs.readText("/repo/CHANGELOG.md");
    // Still exactly ONE [5.11.0] header -- not two.
    expect(changelog.match(/## \[5\.11\.0\]/g)).toHaveLength(1);
    // The pin line describes the FULL span since HEAD (2.1.258, what's
    // actually committed), not the intermediate 2.1.300 nobody will ever see.
    expect(changelog).toContain("Claude Code CLI pin raised **2.1.258 → 2.1.320**");
    expect(changelog).not.toContain("2.1.300");
    // Prior unrelated entries below are untouched.
    expect(changelog).toContain("## [5.10.1]");
  });

  test("F3: fresh iteration (first run, nothing uncommitted yet) still bumps VERSION normally", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs); // VERSION on disk === VERSION at HEAD: this IS fresh
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(depsWithHeadAtSeedRepo()).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(await fs.readText("/repo/VERSION")).toBe("5.11.0\n");
  });

  test("F3: readFileAtHead unavailable (no git) falls back to the pre-#101 always-bump behavior", async () => {
    const fs = new InMemoryFileSystem();
    seedPriorUncommittedIteration(fs); // on-disk VERSION is already 5.11.0
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(baseDeps({
      readBakedClaudeVersion: async () => "2.1.320",
      readFileAtHead: async () => undefined, // git unavailable
    })).run(["update-cli", "2.1.320"], ctx);
    expect(rc).toBe(0);
    // Can't tell this is a repeat, so it bumps again from whatever's on disk
    // -- the safe, previously-shipped behavior, not a new failure mode.
    expect(await fs.readText("/repo/VERSION")).toBe("5.12.0\n");
  });

  test("F3: the replaced entry still ends in a blank line before whatever follows (regression: an earlier version of this fix ate the separator)", async () => {
    const fs = new InMemoryFileSystem();
    seedPriorUncommittedIteration(fs);
    const { ctx } = makeCtx(fs);
    const rc = await new HarnessCommand(depsWithHeadAtSeedRepo({
      readBakedClaudeVersion: async () => "2.1.320",
    })).run(["update-cli", "2.1.320"], ctx);
    expect(rc).toBe(0);
    const changelog = await fs.readText("/repo/CHANGELOG.md");
    // Exactly the shape that follows: pin line, ONE blank line, next header.
    // Caught live against the real CHANGELOG.md: the first version of this
    // replace merged the pin line straight into the next section with no
    // separator at all.
    expect(changelog).toMatch(/Claude Code CLI pin raised \*\*2\.1\.258 → 2\.1\.320\*\*[^\n]*\n\n## \[5\.10\.1\]/);
  });

  test("F3: non-fresh but the prior entry's exact shape isn't found in the CHANGELOG → falls back to inserting a new entry rather than risking corruption, LOUDLY (Arfy's #101 review)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs);
    // VERSION already bumped (non-fresh) but CHANGELOG was never updated to
    // match -- e.g. the warn-and-skip path hit on the prior run.
    fs.seed("/repo/VERSION", "5.11.0\n");
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(depsWithHeadAtSeedRepo({
      readBakedClaudeVersion: async () => "2.1.320",
    })).run(["update-cli", "2.1.320"], ctx);
    expect(rc).toBe(0);
    const changelog = await fs.readText("/repo/CHANGELOG.md");
    expect(changelog).toContain("## [5.11.0]");
    expect(changelog).toContain("Claude Code CLI pin raised **2.1.258 → 2.1.320**");
    expect(stdout.text()).toContain("validated");
    // rc 0 is right (the operation did succeed) but this left the
    // CHANGELOG with two headers for one version -- that must not be
    // silent, per this repo's never-silently-override rule.
    expect(stderr.text()).toContain("didn't match this command's own shape");
    expect(stderr.text()).toContain("Merge the two before committing");
  });

  test("F3: the SAME fallback-insert path on a FRESH iteration stays silent (nothing to merge -- there was no prior entry at all)", async () => {
    const fs = new InMemoryFileSystem();
    seedRepo(fs); // fresh: VERSION on disk === VERSION at HEAD
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new HarnessCommand(depsWithHeadAtSeedRepo()).run(["update-cli", "2.1.319"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toBe("");
  });
});

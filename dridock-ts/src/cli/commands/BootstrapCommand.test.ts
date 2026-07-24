import { test, expect, describe } from "bun:test";
import { BootstrapCommand } from "./BootstrapCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubHostCommandRunner } from "../../infra/HostCommandRunner.ts";
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

describe("BootstrapCommand — greenfield", () => {
  test("empty dir → scaffolds .dridock/config.yml + BRIEF.md + README.md + workloads/ + gitignore", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await cmd.run(["build the thing"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("🚀 bootstrapped");
    // Files present
    expect(await fs.exists("/repo/.dridock/config.yml")).toBe(true);
    expect(await fs.exists("/repo/.dridock/BRIEF.md")).toBe(true);
    expect(await fs.exists("/repo/README.md")).toBe(true);
    expect(await fs.exists("/repo/workloads/.gitkeep")).toBe(true);
    // Config has id + defaults
    const cfg = await fs.readText("/repo/.dridock/config.yml");
    expect(cfg).toMatch(/^id: [a-f0-9]{8}$/m);
    expect(cfg).toContain("cpu:");
    // Brief includes the intent
    expect(await fs.readText("/repo/.dridock/BRIEF.md")).toContain("build the thing");
  });

  test("intent via --brief-file", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/tmp/brief.txt", "the intent from a file\n");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    await cmd.run(["--brief-file", "/tmp/brief.txt"], ctx);
    expect(await fs.readText("/repo/.dridock/BRIEF.md")).toContain("the intent from a file");
  });

  test("intent via stdin when no arg + no --brief-file", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "piped intent\n");
    const { ctx } = makeCtx(fs);
    await cmd.run([], ctx);
    expect(await fs.readText("/repo/.dridock/BRIEF.md")).toContain("piped intent");
  });

  test("existing BRIEF.md + no --force → rc 1", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/BRIEF.md", "# existing\n");
    const host = new StubHostCommandRunner();
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["intent"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("already exists");
  });

  test("existing BRIEF.md + --force → overwrites", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/BRIEF.md", "# old\n");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run(["--force", "new intent"], ctx);
    expect(rc).toBe(0);
    expect(await fs.readText("/repo/.dridock/BRIEF.md")).toContain("new intent");
  });

  test("--brief-only skips file-scaffolding but still writes BRIEF + config", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    await cmd.run(["--brief-only", "intent"], ctx);
    expect(await fs.exists("/repo/.dridock/BRIEF.md")).toBe(true);
    expect(await fs.exists("/repo/.dridock/config.yml")).toBe(true);
    // But NO greenfield artifacts
    expect(await fs.exists("/repo/README.md")).toBe(false);
    expect(await fs.exists("/repo/workloads/.gitkeep")).toBe(false);
    // No git init either
    expect(host.calls.some((c) => c.includes("git -C"))).toBe(false);
  });
});

describe("BootstrapCommand — adopt", () => {
  test("--adopt (no url) with existing .git → skips greenfield scaffolding", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/repo/.git");
    const host = new StubHostCommandRunner();
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    await cmd.run(["--adopt", "intent"], ctx);
    expect(stdout.text()).toContain("🚀 adopted");
    // No README written, no workloads
    expect(await fs.exists("/repo/README.md")).toBe(false);
    expect(await fs.exists("/repo/workloads/.gitkeep")).toBe(false);
    // But BRIEF + config still there
    expect(await fs.exists("/repo/.dridock/BRIEF.md")).toBe(true);
  });

  test("--adopt (no url) without existing .git → rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--adopt"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no git repo");
  });

  test("--adopt <url> → clones via gh-then-git fallback, then adopts", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    // gh clone succeeds
    host.seedCommand(`command -v gh >/dev/null 2>&1 && gh repo clone 'https://github.com/x/y.git' '/repo' 2>/dev/null`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    // Simulate that the clone created .git after cloning
    fs.seedDir("/repo/.git");
    const rc = await cmd.run(["--adopt", "https://github.com/x/y.git"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("cloned y");
    expect(stdout.text()).toContain("🚀 adopted");
  });

  test("--adopt <url> gh fails, git succeeds", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`command -v gh >/dev/null 2>&1 && gh repo clone 'https://github.com/x/y.git' '/repo' 2>/dev/null`, 1, "");
    host.seedCommand(`git clone -q 'https://github.com/x/y.git' '/repo'`, 0, "");
    fs.seedDir("/repo/.git");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    await cmd.run(["--adopt", "https://github.com/x/y.git"], ctx);
    expect(stdout.text()).toContain("cloned y");
  });

  test("--adopt <url> both fail → rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    // Both unseeded → both rc 127 (fake default)
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--adopt", "https://github.com/private/repo.git"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("clone failed");
  });
});

describe("BootstrapCommand — workspace + repos", () => {
  test("--workspace → 'multi-repo workspace' banner + parent gitignores machine-local files", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    await cmd.run(["--workspace", "intent"], ctx);
    expect(stdout.text()).toContain("🚀 multi-repo workspace");
    const gi = await fs.readText("/repo/.gitignore");
    expect(gi).toContain("/.dridock/config.yml");
    expect(gi).toContain("/.dridock/secrets.env");
  });

  test("--repo clones sibling + gitignores it (implies --workspace)", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    host.seedCommand(`command -v gh >/dev/null 2>&1 && gh repo clone 'https://github.com/x/y.git' '/repo/y' 2>/dev/null`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    await cmd.run(["--repo", "https://github.com/x/y.git", "intent"], ctx);
    expect(stdout.text()).toContain("cloned + gitignored");
    expect(await fs.readText("/repo/.gitignore")).toContain("/y/");
  });

  test("--repo clone failure → rc 1 (bootstrap partial)", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    // Both clone commands unseeded → both fail
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--repo", "https://github.com/x/y.git"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("clone failed");
    expect(stderr.text()).toContain("bootstrap partial");
  });

  test("--adopt + --workspace mutually exclusive → DridockError", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/repo/.git");
    const cmd = new BootstrapCommand(new StubHostCommandRunner(), async () => "");
    const { ctx } = makeCtx(fs);
    try {
      await cmd.run(["--adopt", "--workspace"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });
});

describe("BootstrapCommand — secrets", () => {
  test("--seed-secret runs CMD + writes KEY=<stdout> to secrets.env, chmod 600", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    host.seedCommand("gh auth token", 0, "ghp_test-token\n");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    await cmd.run(["--seed-secret", "GH_TOKEN=gh auth token"], ctx);
    const secrets = await fs.readText("/repo/.dridock/secrets.env");
    expect(secrets).toContain("GH_TOKEN=ghp_test-token");
    expect(fs.modeOf("/repo/.dridock/secrets.env")).toBe(0o600);
  });

  test("--gh-token is a shorthand for --seed-secret GH_TOKEN='gh auth token'", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    host.seedCommand("gh auth token", 0, "ghp_test-abc\n");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    await cmd.run(["--gh-token"], ctx);
    expect(await fs.readText("/repo/.dridock/secrets.env")).toContain("GH_TOKEN=ghp_test-abc");
  });

  test("--seed-secret command fails → skipped with warning, other secrets still land", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    host.seedCommand("gh auth token", 1, "");
    host.seedCommand("cat token.txt", 0, "another-token\n");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    await cmd.run(["--seed-secret", "GH_TOKEN=gh auth token", "--seed-secret", "OTHER=cat token.txt"], ctx);
    expect(stderr.text()).toContain("seed-secret GH_TOKEN: command failed");
    const secrets = await fs.readText("/repo/.dridock/secrets.env");
    expect(secrets).not.toContain("GH_TOKEN=");
    expect(secrets).toContain("OTHER=another-token");
  });

  test("--secrets-file merges KEY=VALUE lines", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/tmp/merge.env", "A=1\nB=2\n# comment ignored\nnotakey\n");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    await cmd.run(["--secrets-file", "/tmp/merge.env"], ctx);
    const secrets = await fs.readText("/repo/.dridock/secrets.env");
    expect(secrets).toContain("A=1");
    expect(secrets).toContain("B=2");
    expect(secrets).not.toContain("notakey");
    expect(secrets).not.toContain("comment");
  });

  test("--secrets-file not found → rc 1", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["--secrets-file", "/tmp/missing.env"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("--secrets-file not found");
  });

  test("--seed-secret with bad KEY=CMD → DridockError", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx } = makeCtx(fs);
    try {
      await new BootstrapCommand(new StubHostCommandRunner(), async () => "").run(["--seed-secret", "NO_EQUALS_HERE"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });
});

describe("BootstrapCommand — misc flags", () => {
  test("unknown flag → DridockError", async () => {
    const { ctx } = makeCtx(new InMemoryFileSystem());
    try {
      await new BootstrapCommand(new StubHostCommandRunner(), async () => "").run(["--nonsense"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });

  test("--help prints usage + rc 1 (usage returns undefined → 1)", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new BootstrapCommand(new StubHostCommandRunner(), async () => "").run(["--help"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toContain("usage: dridock bootstrap");
  });
});

/**
 * #42 — `dridock-ts start` (indirectly, via a bootstrap re-run) regenerated
 * the project id and clobbered `.dridock/config.yml`, silently orphaning
 * the id-keyed `~/.claude` mount. Root cause: writeInitialConfig always
 * minted + always overwrote, with no exists-guard for `id:`. Bash-parity
 * requires preserving any existing real id (cb_project_id gate at
 * wrapper.sh:504/523).
 *
 * Two tested facets:
 *   1. Preserve existing id — the actual regression.
 *   2. Loud orphan warning when a fresh id WILL discard sibling sessions.
 */
describe("BootstrapCommand — #42 facet 1: preserve existing project id", () => {
  test("existing config.yml with real id → id preserved, config NOT overwritten", async () => {
    const fs = new InMemoryFileSystem();
    // Pre-existing config (as if bootstrap was already run once) — INCL.
    // a user-edited hostname the re-run must not lose.
    const preExisting = `# .dridock/config.yml — generated by the wrapper; edit to taste. Gitignored.
id: 69adc719
vm:
  cpu: 8
  memory: 16GiB
  disk: 100GiB
network:
  hostname: myproj-hand-set
`;
    fs.seed("/repo/.dridock/config.yml", preExisting);
    fs.seed("/repo/.dridock/BRIEF.md", "# existing brief\n");   // present but --force overrides it
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stdout } = makeCtx(fs);
    // --force lets the BRIEF check pass so we exercise the config write path
    const rc = await cmd.run(["--force", "rebootstrap intent"], ctx);
    expect(rc).toBe(0);
    // Config.yml is byte-identical to what we seeded — nothing rewritten.
    expect(await fs.readText("/repo/.dridock/config.yml")).toBe(preExisting);
    // And the notice reflects preservation, not fresh minting.
    expect(stdout.text()).toContain("preserved existing id 69adc719");
  });

  test("existing config.yml with id: auto → treated as unbootstrapped, mints fresh", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: auto\nvm:\n  cpu: 4\n");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run(["fresh intent"], ctx);
    expect(rc).toBe(0);
    // A real id was minted (matches [a-f0-9]{8}) — replaced "auto".
    const cfg = await fs.readText("/repo/.dridock/config.yml");
    expect(cfg).toMatch(/^id: [a-f0-9]{8}$/m);
    expect(cfg).not.toContain("id: auto");
  });

  test("no config.yml at all → mints fresh (regression-safe: preserve doesn't accidentally create empty files)", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    const rc = await cmd.run(["intent"], ctx);
    expect(rc).toBe(0);
    const cfg = await fs.readText("/repo/.dridock/config.yml");
    expect(cfg).toMatch(/^id: [a-f0-9]{8}$/m);
  });

  test("existing config.yml with empty id: value → treated as fresh (not preserved as \"\")", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id:\nvm:\n  cpu: 4\n");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx } = makeCtx(fs);
    await cmd.run(["intent"], ctx);
    const cfg = await fs.readText("/repo/.dridock/config.yml");
    expect(cfg).toMatch(/^id: [a-f0-9]{8}$/m);
  });
});

describe("BootstrapCommand — #42 facet 2: orphan-session warning on mint", () => {
  test("fresh bootstrap + sibling sessions exist under other id → stderr warning + list of orphaned dirs", async () => {
    const fs = new InMemoryFileSystem();
    // XDG projects tree with sessions belonging to a different id, keyed on
    // OUR cwd's slug (/repo → -repo). The bug turns those into orphans.
    fs.seed("/home/alan/.config/dridock/projects/69adc719/claude/projects/-repo/session-a.jsonl", "{}");
    fs.seed("/home/alan/.config/dridock/projects/aabbccdd/claude/projects/-repo/session-b.jsonl", "{}");
    // And an UNRELATED slug that must NOT trigger a warning.
    fs.seed("/home/alan/.config/dridock/projects/ff00ff00/claude/projects/-other-workspace/x.jsonl", "{}");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await cmd.run(["intent"], ctx);
    expect(rc).toBe(0);
    const warn = stderr.text();
    expect(warn).toContain(`⚠️  bootstrap: minting a NEW project id will silently orphan`);
    expect(warn).toContain(`/home/alan/.config/dridock/projects/69adc719/claude/projects/-repo`);
    expect(warn).toContain(`/home/alan/.config/dridock/projects/aabbccdd/claude/projects/-repo`);
    // The unrelated project must NOT appear.
    expect(warn).not.toContain(`ff00ff00`);
    // Recovery instructions present.
    expect(warn).toContain(`id: <one-of-the-above>`);
    expect(warn).toContain(`Continuing with a fresh id anyway`);
  });

  test("fresh bootstrap + no sibling sessions → NO warning (silent happy path)", async () => {
    const fs = new InMemoryFileSystem();
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    await cmd.run(["intent"], ctx);
    expect(stderr.text()).toBe("");
  });

  test("PRESERVED-id path does NOT emit orphan warning (no mint = no orphan risk)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: 69adc719\n");
    fs.seed("/repo/.dridock/BRIEF.md", "existing\n");
    // Even a HUGE sibling-session forest — since we're preserving the id
    // that owns them, they're not orphans.
    fs.seed("/home/alan/.config/dridock/projects/deadbeef/claude/projects/-repo/leftover.jsonl", "{}");
    const host = new StubHostCommandRunner();
    host.seedCommand(`git -C '/repo' init -q`, 0, "");
    const cmd = new BootstrapCommand(host, async () => "");
    const { ctx, stderr } = makeCtx(fs);
    await cmd.run(["--force", "rebootstrap"], ctx);
    expect(stderr.text()).toBe("");
  });

  test("XDG_CONFIG_HOME override respected (scanner reads the same root MachineConfig writes to)", async () => {
    const savedXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
    try {
      const fs = new InMemoryFileSystem();
      fs.seed("/custom/xdg/dridock/projects/aa112233/claude/projects/-repo/s.jsonl", "{}");
      const host = new StubHostCommandRunner();
      host.seedCommand(`git -C '/repo' init -q`, 0, "");
      const cmd = new BootstrapCommand(host, async () => "");
      const { ctx, stderr } = makeCtx(fs);
      await cmd.run(["intent"], ctx);
      expect(stderr.text()).toContain(`/custom/xdg/dridock/projects/aa112233/claude/projects/-repo`);
    } finally {
      if (savedXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = savedXdg;
    }
  });
});

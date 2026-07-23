import { test, expect, describe } from "bun:test";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { FrozenClock } from "../../infra/Clock.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DridockError } from "../../domain/errors.ts";
import { VmCommand } from "./VmCommand.ts";
import { IpCommand, NetCommand } from "./IpNetCommand.ts";
import { DfCommand } from "./DfCommand.ts";
import { CompletionCommand } from "./CompletionCommand.ts";
import { FrameworkBugsCommand } from "./FrameworkBugsCommand.ts";
import { ReportBugCommand } from "./ReportBugCommand.ts";
import { ClearSessionCommand } from "./ClearSessionCommand.ts";
import { SetupTokenCommand, DoctorCommand, AuthCommand, McpCommand } from "./ThrowawayCommands.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

describe("VmCommand.ls", () => {
  test("no project VMs → 'no dridock project VMs' + optional cb-infra line", async () => {
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    await new VmCommand(colima).run(["ls"], ctx);
    expect(stdout.text()).toContain("no dridock project VMs");
    expect(stdout.text()).toContain("infra (cb-infra): Running");
  });

  test("project VMs listed sorted by name; cb-infra broken out", async () => {
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-zulu", status: "Stopped", address: "" });
    colima.seedVm({ name: "cb-alpha", status: "Running", address: "1.1.1.1" });
    colima.seedVm({ name: "cb-infra", status: "Stopped", address: "" });
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    await new VmCommand(colima).run(["ls"], ctx);
    const out = stdout.text();
    // cb-alpha appears before cb-zulu
    expect(out.indexOf("cb-alpha")).toBeLessThan(out.indexOf("cb-zulu"));
    expect(out).toContain("PROFILE");
    expect(out).toContain("infra (cb-infra): Stopped");
  });

  test("bare `vm` defaults to ls", async () => {
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-a", status: "Running", address: "1.1.1.1" });
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    await new VmCommand(colima).run([], ctx);
    expect(stdout.text()).toContain("cb-a");
  });

  test("unknown sub-verb → DridockError", async () => {
    try {
      await new VmCommand(new InMemoryColima()).run(["nonsense"], makeCtx(new InMemoryFileSystem()).ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
    }
  });
});

describe("IpCommand", () => {
  test("no config.yml → rc 1 with hint", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new IpCommand(new InMemoryColima(), new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no dridock project here");
  });

  test("VM reachable → prints IP as single line rc 0", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new IpCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text().trim()).toBe("1.2.3.4");
  });

  test("VM has no address yet → rc 1 with 'try again' hint", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "" });
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new IpCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no reachable IP yet");
  });
});

describe("NetCommand", () => {
  test("prints VM IP + browse hint; hostname unset → 'no hostname' suggestion", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new NetCommand(colima, new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("project VM cb-abc: 1.2.3.4");
    expect(stdout.text()).toContain("no network.hostname set");
  });

  test("with hostname arg → writes network.hostname to config + prints /etc/hosts line", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nvm:\n  cpu: 4\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    await new NetCommand(colima, new StubGitToplevel("/p")).run(["myapp"], ctx);
    const cfg = await fs.readText("/p/.dridock/config.yml");
    expect(cfg).toContain("network:\n  hostname: myapp");
    expect(cfg).toContain("id: abc");   // preserved
    expect(cfg).toContain("cpu: 4");    // preserved
    expect(stdout.text()).toContain(`echo "1.2.3.4  myapp" | sudo tee -a /etc/hosts`);
  });

  test("invalid hostname → DridockError, config unchanged", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    const { ctx } = makeCtx(fs);
    try {
      await new NetCommand(colima, new StubGitToplevel("/p")).run(["bad name!"], ctx);
      throw new Error("expected DridockError");
    } catch (e) {
      expect(e).toBeInstanceOf(DridockError);
    }
    // Config unchanged
    expect(await fs.readText("/p/.dridock/config.yml")).toBe("id: abc\n");
  });

  test("replaces existing network:hostname (no duplication)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\nnetwork:\n  hostname: old-name\n");
    const { ctx } = makeCtx(fs);
    await new NetCommand(new InMemoryColima(), new StubGitToplevel("/p")).run(["new-name"], ctx);
    const cfg = await fs.readText("/p/.dridock/config.yml");
    expect(cfg).toContain("hostname: new-name");
    expect(cfg).not.toContain("old-name");
    expect(cfg.match(/^network:/gm)?.length ?? 0).toBe(1);
  });
});

describe("DfCommand — delegates to VmDiskUsageService", () => {
  test("no VMs → '(no dridock VMs)' rc 0", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new DfCommand(new InMemoryColima()).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("(no dridock VMs)");
  });

  test("VMs → prints PROFILE/STATUS/MAX columns", async () => {
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.1.1.1", disk: "60GiB" });
    colima.seedVm({ name: "cb-infra", status: "Running", address: "", disk: "40GiB" });
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    await new DfCommand(colima).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("PROFILE");
    expect(out).toContain("cb-abc");
    expect(out).toContain("60GiB");
    expect(out).toContain("cb-infra");
    expect(out).toContain("40GiB");
    // Notes that on-disk actual is Mac-only
    expect(out).toContain("on-disk actual");
  });
});

describe("CompletionCommand", () => {
  test("bash → prints a bash completion script including our verbs", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new CompletionCommand().run(["bash"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("bash completion");
    expect(out).toContain("_dridock_complete");
    // A few verbs present
    expect(out).toContain("start");
    expect(out).toContain("consult");
    expect(out).toContain("checkversion");
  });

  test("unknown shell → DridockError", async () => {
    const { ctx } = makeCtx(new InMemoryFileSystem());
    try {
      await new CompletionCommand().run(["zsh"], ctx);
      throw new Error("expected DridockError");
    } catch (e) { expect(e).toBeInstanceOf(DridockError); }
  });

  test("no shell arg → rc 1 usage", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new CompletionCommand().run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage: dridock completion bash");
  });
});

describe("FrameworkBugsCommand", () => {
  test("list: no dir → 'no framework bug reports' rc 0", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new FrameworkBugsCommand().run(["list"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("no framework bug reports");
  });

  test("list: dir with .md → surfaces filenames + titles", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/framework-bugs/bug1.md", "# First bug\n\nbody\n");
    fs.seed("/home/alan/.config/dridock/framework-bugs/bug2.md", "# Second bug\nbody\n");
    const { ctx, stdout } = makeCtx(fs);
    await new FrameworkBugsCommand().run(["list"], ctx);
    const out = stdout.text();
    expect(out).toContain("bug1.md");
    expect(out).toContain("First bug");
    expect(out).toContain("Second bug");
  });

  test("clear: removes .md files, prints count", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/framework-bugs/bug1.md", "# x\n");
    fs.seed("/home/alan/.config/dridock/framework-bugs/bug2.md", "# y\n");
    fs.seed("/home/alan/.config/dridock/framework-bugs/keep.txt", "not a report");
    const { ctx, stdout } = makeCtx(fs);
    await new FrameworkBugsCommand().run(["clear"], ctx);
    expect(await fs.exists("/home/alan/.config/dridock/framework-bugs/bug1.md")).toBe(false);
    expect(await fs.exists("/home/alan/.config/dridock/framework-bugs/keep.txt")).toBe(true);
    expect(stdout.text()).toContain("cleared 2");
  });
});

describe("ReportBugCommand", () => {
  test("writes markdown file with title + layer + body + project id", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc12345\n");
    const { ctx, stdout } = makeCtx(fs);
    const cmd = new ReportBugCommand(
      new FrozenClock("20260722010203"),
      new StubGitToplevel("/p"),
      async () => "## What I did\nran the thing\n",
    );
    const rc = await cmd.run(["The broken thing", "--layer", "wrapper"], ctx);
    expect(rc).toBe(0);
    // Slug: "the-broken-thing", ts 20260722010203, id abc12345
    const path = `/home/alan/.config/dridock/framework-bugs/abc12345-20260722010203-the-broken-thing.md`;
    const content = await fs.readText(path);
    expect(content).toContain("# The broken thing");
    expect(content).toContain("**Layer:** wrapper");
    expect(content).toContain("**Project:** abc12345");
    expect(content).toContain("What I did");
    expect(stdout.text()).toContain(`filed: ${path}`);
  });

  test("no title → rc 1 usage", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const cmd = new ReportBugCommand(new FrozenClock(), new StubGitToplevel("/p"), async () => "");
    const rc = await cmd.run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage:");
  });
});

describe("ClearSessionCommand", () => {
  test("no session dir → 'no session found' rc 0", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new ClearSessionCommand().run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("no session found");
  });

  test("session dir present → rm -rf'd, message printed", async () => {
    const fs = new InMemoryFileSystem();
    // Slug for cwd=/p is "-p"
    fs.seed("/home/alan/.claude/projects/-p/history.jsonl", "{}\n");
    const { ctx, stdout } = makeCtx(fs);
    await new ClearSessionCommand().run([], ctx);
    expect(await fs.exists("/home/alan/.claude/projects/-p")).toBe(false);
    expect(stdout.text()).toContain("cleared session");
  });
});

describe("Throwaway container commands (setup-token/doctor/auth/mcp)", () => {
  test("setup-token runs `claude setup-token` in a throwaway container via runCapture", async () => {
    const docker = new InMemoryDocker();
    docker.seedRunCapture("dridock:latest", ["setup-token"], 0, "please visit https://…\n");
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new SetupTokenCommand(docker).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("please visit");
    expect(docker.runCalls[0]!.opts.entrypoint).toBe("claude");
    expect(docker.runCalls[0]!.opts.args).toEqual(["setup-token"]);
  });

  test("doctor passes through extra args", async () => {
    const docker = new InMemoryDocker();
    docker.runCaptureFallback = { rc: 0, stdout: "ok\n" };
    const { ctx } = makeCtx(new InMemoryFileSystem());
    await new DoctorCommand(docker).run(["--verbose"], ctx);
    expect(docker.runCalls[0]!.opts.args).toEqual(["doctor", "--verbose"]);
  });

  test("auth returns docker rc verbatim", async () => {
    const docker = new InMemoryDocker();
    docker.runCaptureFallback = { rc: 42, stdout: "" };
    const { ctx } = makeCtx(new InMemoryFileSystem());
    const rc = await new AuthCommand(docker).run(["login"], ctx);
    expect(rc).toBe(42);
    expect(docker.runCalls[0]!.opts.args).toEqual(["auth", "login"]);
  });

  test("mcp works too", async () => {
    const docker = new InMemoryDocker();
    docker.runCaptureFallback = { rc: 0, stdout: "" };
    const { ctx } = makeCtx(new InMemoryFileSystem());
    await new McpCommand(docker).run(["list"], ctx);
    expect(docker.runCalls[0]!.opts.args).toEqual(["mcp", "list"]);
  });
});

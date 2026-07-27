import { test, expect, describe } from "bun:test";
import { ClaudeDirCommand } from "./ClaudeDirCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

/** Test ctx builder — env is passed EXPLICITLY via `opts.env` (fixes #51:
 *  ctx.env is now the authoritative env source, no process.env leak). */
function makeCtx(fs: InMemoryFileSystem, opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver(opts.env ?? {}), cwd: opts.cwd ?? "/p", home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

describe("ClaudeDirCommand — bash-parity output (wrapper.sh:2560-2573)", () => {
  test("project bootstrapped → prints <xdg>/projects/<id>/claude", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs, { env: { XDG_CONFIG_HOME: "/home/alan/.config" } });
    const rc = await new ClaudeDirCommand(new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/home/alan/.config/dridock/projects/abc/claude\n");
  });

  test("DRIDOCK_DATA_DIR override wins — used AS-IS, no /<id>/claude suffix", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs, { env: { DRIDOCK_DATA_DIR: "/tmp/custom-claude-dir" } });
    const rc = await new ClaudeDirCommand(new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/tmp/custom-claude-dir\n");
  });

  test("DRIDOCK_DATA_DIR override + no project → still prints (bash parity)", async () => {
    // Bash checks `[ -n "$_dd" ]` FIRST, before the project-id check —
    // so an env override lets `claude-dir` succeed even outside a project.
    const fs = new InMemoryFileSystem();
    const { ctx, stdout, stderr } = makeCtx(fs, { env: { DRIDOCK_DATA_DIR: "/tmp/anywhere" } });
    const rc = await new ClaudeDirCommand(new StubGitToplevel(undefined)).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/tmp/anywhere\n");
    expect(stderr.text()).toBe("");
  });

  test("no project + no override → rc 1 with 'no dridock project' stderr", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new ClaudeDirCommand(new StubGitToplevel(undefined)).run([], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no dridock project here");
  });

  test("legacy CLAUDE_DATA_DIR fallback honored when DRIDOCK_DATA_DIR unset", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs, { env: { CLAUDE_DATA_DIR: "/legacy/claude" } });
    const rc = await new ClaudeDirCommand(new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/legacy/claude\n");
  });
});

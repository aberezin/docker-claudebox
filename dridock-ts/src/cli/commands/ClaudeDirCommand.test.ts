import { test, expect, describe, afterEach } from "bun:test";
import { ClaudeDirCommand } from "./ClaudeDirCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

// MachineConfig + ClaudeDirCommand both read from process.env for the
// override (matches the wider StartCommand pattern). Snapshot + restore
// so tests don't leak into each other or the surrounding session.
const ENV_KEYS = ["DRIDOCK_DATA_DIR", "CLAUDE_DATA_DIR", "XDG_CONFIG_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
});
function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
  if (savedEnv[k] === undefined && !(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe("ClaudeDirCommand — bash-parity output (wrapper.sh:2560-2573)", () => {
  test("project bootstrapped → prints <xdg>/projects/<id>/claude", async () => {
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    setEnv("DRIDOCK_DATA_DIR", undefined);
    setEnv("CLAUDE_DATA_DIR", undefined);
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new ClaudeDirCommand(new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/home/alan/.config/dridock/projects/abc/claude\n");
  });

  test("DRIDOCK_DATA_DIR override wins — used AS-IS, no /<id>/claude suffix", async () => {
    setEnv("DRIDOCK_DATA_DIR", "/tmp/custom-claude-dir");
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new ClaudeDirCommand(new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/tmp/custom-claude-dir\n");
  });

  test("DRIDOCK_DATA_DIR override + no project → still prints (bash parity)", async () => {
    // Bash checks `[ -n "$_dd" ]` FIRST, before the project-id check —
    // so an env override lets `claude-dir` succeed even outside a project.
    setEnv("DRIDOCK_DATA_DIR", "/tmp/anywhere");
    const fs = new InMemoryFileSystem();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new ClaudeDirCommand(new StubGitToplevel(undefined)).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/tmp/anywhere\n");
    expect(stderr.text()).toBe("");
  });

  test("no project + no override → rc 1 with 'no dridock project' stderr", async () => {
    setEnv("DRIDOCK_DATA_DIR", undefined);
    setEnv("CLAUDE_DATA_DIR", undefined);
    const fs = new InMemoryFileSystem();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new ClaudeDirCommand(new StubGitToplevel(undefined)).run([], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no dridock project here");
  });

  test("legacy CLAUDE_DATA_DIR fallback honored when DRIDOCK_DATA_DIR unset", async () => {
    setEnv("DRIDOCK_DATA_DIR", undefined);
    setEnv("CLAUDE_DATA_DIR", "/legacy/claude");
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new ClaudeDirCommand(new StubGitToplevel("/p")).run([], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("/legacy/claude\n");
  });
});

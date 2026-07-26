import { test, expect, describe, afterEach } from "bun:test";
import { TeamCommand } from "./TeamCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

// The command reads DRIDOCK_AGENT_NAME from process.env — snapshot + restore.
const ENV_KEYS = ["DRIDOCK_AGENT_NAME"] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in saved)) continue;
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function makeCtx(fs: InMemoryFileSystem, cwd = "/proj"): { ctx: Context; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return {
    stdout, stderr,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr },
  };
}

const CANONICAL_ROSTER = `agents:\n  - name: Bear\n    role: principal-engineer\n    environment: container\n  - name: Arfy\n    role: senior-qa\n    environment: host-macos\nhuman: Alan\n`;

function seedProject(fs: InMemoryFileSystem, roster: string = CANONICAL_ROSTER): void {
  fs.seed("/proj/.dridock/config.yml", "id: abc12345\n");
  fs.seed("/proj/.dridock/agents.yml", roster);
}

describe("TeamCommand — arg + roster preconditions", () => {
  test("no subcommand → usage + rc 1", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run([], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("usage: dridock team <subcommand>");
  });

  test("--help → usage + rc 0", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["--help"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("Subcommands:");
  });

  test("unknown subcommand → rc 1 + allowed list", async () => {
    const { ctx, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["bogus"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("unknown subcommand 'bogus'");
    expect(stderr.text()).toContain("whoami, roster, post");
  });

  test("roster file missing → rc 1 + spec pointer", async () => {
    const fs = new InMemoryFileSystem();
    // config.yml present but agents.yml absent
    fs.seed("/proj/.dridock/config.yml", "id: abc\n");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no roster at /proj/.dridock/agents.yml");
    expect(stderr.text()).toContain("agent-teams.md §1");
  });

  test("roster malformed → rc 1 with parser error message", async () => {
    const fs = new InMemoryFileSystem();
    seedProject(fs, `agents:\n  - role: eng\n`); // no 'name:'
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("malformed roster");
    expect(stderr.text()).toContain("without a 'name:' field");
  });
});

describe("TeamCommand.whoami — resolve THIS runtime's agent name", () => {
  test("env set + in roster → prints name to stdout, source to stderr, rc 0", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami"], ctx);
    expect(rc).toBe(0);
    // Pipe-clean: stdout is JUST the name (safe for `SELF=$(dridock team whoami)`).
    expect(stdout.text()).toBe("Bear\n");
    expect(stderr.text()).toContain("DRIDOCK_AGENT_NAME env");
  });

  test("env unset + single-agent roster → uses fallback, source annotation reflects it", async () => {
    setEnv("DRIDOCK_AGENT_NAME", undefined);
    const fs = new InMemoryFileSystem();
    seedProject(fs, `agents:\n  - name: Solo\n`);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Solo\n");
    expect(stderr.text()).toContain("single-agent roster fallback");
  });

  test("env unset + multi-agent roster → error naming candidates + fix path", async () => {
    setEnv("DRIDOCK_AGENT_NAME", undefined);
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("DRIDOCK_AGENT_NAME is unset");
    expect(stderr.text()).toContain("Bear, Arfy");
  });

  test("env set + NOT in roster → typo error", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Ghost");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("'Ghost' isn't in the roster");
  });
});

describe("TeamCommand.roster — print the team", () => {
  test("canonical roster prints agents + human with meta", async () => {
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["roster"], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("team roster:");
    expect(out).toContain("- Bear  (role=principal-engineer, env=container)");
    expect(out).toContain("- Arfy  (role=senior-qa, env=host-macos)");
    expect(out).toContain("human: Alan");
  });

  test("agent with no role/env → prints just the name (no empty parens)", async () => {
    const fs = new InMemoryFileSystem();
    seedProject(fs, `agents:\n  - name: Solo\n`);
    const { ctx, stdout } = makeCtx(fs);
    await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["roster"], ctx);
    // Solo has no meta — the line should be `    - Solo` with no `()` suffix.
    expect(stdout.text()).toMatch(/^ {4}- Solo$/m);
    expect(stdout.text()).not.toContain("()");
  });

  test("roster without human key → doesn't print a 'human:' line", async () => {
    const fs = new InMemoryFileSystem();
    seedProject(fs, `agents:\n  - name: Bear\n  - name: Arfy\n`);
    const { ctx, stdout } = makeCtx(fs);
    await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["roster"], ctx);
    expect(stdout.text()).not.toContain("human:");
  });

  test("roster doesn't need DRIDOCK_AGENT_NAME to be set (no selfName resolution)", async () => {
    // No env set, multi-agent roster — would fail whoami; roster still works.
    setEnv("DRIDOCK_AGENT_NAME", undefined);
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["roster"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("- Bear");
    expect(stdout.text()).toContain("- Arfy");
  });
});

describe("TeamCommand.post — prepend sender header to stdin", () => {
  test("broadcast: no --to, body from stdin → 'Bear: <body>'", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "the message body\n",
    ).run(["post"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear: the message body\n");
  });

  test("directed: --to Arfy → 'Bear->Arfy: <body>'", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "hi\n",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear->Arfy: hi\n");
  });

  test("directed multi: --to Arfy,Alan → 'Bear->Arfy,Alan: <body>' (human is a valid recipient)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "check this\n",
    ).run(["post", "--to=Arfy,Alan"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear->Arfy,Alan: check this\n");
  });

  test("empty stdin → header alone on its own line (still useful for salutation follow-up)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear->Arfy:\n");
  });

  test("multi-line body → header on same line as first content line, rest preserved", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "line 1\nline 2\nline 3\n",
    ).run(["post"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear: line 1\nline 2\nline 3\n");
  });

  test("recipient typo → rc 1 with 'not in the roster' + valid names", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "body",
    ).run(["post", "--to", "Alanm"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("'Alanm' isn't in the roster");
    expect(stderr.text()).toContain("Bear, Arfy, Alan");
  });

  test("recipient CAN be the human (spec §2.3: 'The human is a valid recipient')", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "for you specifically",
    ).run(["post", "--to", "Alan"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("Bear->Alan: for you specifically");
  });

  test("unexpected arg → rc 1", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "body",
    ).run(["post", "--nonsense"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("unexpected argument '--nonsense'");
  });
});

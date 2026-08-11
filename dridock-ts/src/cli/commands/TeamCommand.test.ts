import { test, expect, describe, afterEach } from "bun:test";
import { TeamCommand } from "./TeamCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StubHostCommandRunner } from "../../infra/HostCommandRunner.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";

// The command reads several env vars — snapshot + restore.
const ENV_KEYS = ["DRIDOCK_AGENT_NAME", "XDG_CONFIG_HOME", "DRIDOCK_WATCH_POLL_INTERVAL_MS", "DEBUG"] as const;
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

  test("empty stdin → rc 1 (header-only comment is never intentional; #59 rejection)", async () => {
    // Was previously "empty stdin → header alone on its own line" —
    // Arfy's #56 comment 5258528435 showed that a header-only /
    // trivially-short body has historically indicated a broken send
    // pipeline (the `@-` incident). Reject at the boundary instead.
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("body is empty");
    expect(stderr.text()).toContain("never intentional");
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

/** Roster helper for watch tests — includes github_repo. */
const ROSTER_WITH_REPO = CANONICAL_ROSTER.replace(/human: Alan\n/, `human: Alan\ngithub_repo: aberezin/docker-claudebox\n`);

/** Seed a `gh api` stub that returns `comments` on the comments query and
 *  `issues` on the issues query. Both keyed on the exact `since=<iso>`
 *  URL the source builds. */
function seedGh(runner: StubHostCommandRunner, since: string, comments: object[], issues: object[]): void {
  const encoded = encodeURIComponent(since);
  const commentsCmd = `gh api "repos/aberezin/docker-claudebox/issues/comments?since=${encoded}&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]?'`;
  const issuesCmd = `gh api "repos/aberezin/docker-claudebox/issues?since=${encoded}&state=all&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]? | select(.pull_request == null)'`;
  runner.seedCommand(commentsCmd, 0, comments.length === 0 ? "" : comments.map((c) => JSON.stringify(c)).join("\n") + "\n");
  runner.seedCommand(issuesCmd, 0, issues.length === 0 ? "" : issues.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

describe("TeamCommand.watch — arg validation + config resolution", () => {
  test("no roster.githubRepo AND no --repo → rc 1 with add-to-roster hint", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs); // roster without github_repo
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host: new StubHostCommandRunner(), sleep: async () => {},
    }, async () => "").run(["watch", "--once"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no GitHub repo configured");
    expect(stderr.text()).toContain("github_repo: owner/name");
    expect(stderr.text()).toContain("--repo owner/name");
  });

  test("--repo malformed → rc 1 with 'expected owner/name'", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host: new StubHostCommandRunner(), sleep: async () => {},
    }, async () => "").run(["watch", "--once", "--repo", "not-a-repo"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("invalid repo 'not-a-repo'");
  });

  test("--interval below 1000 → rc 1", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host: new StubHostCommandRunner(), sleep: async () => {},
    }, async () => "").run(["watch", "--interval", "500"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("--interval must be a number >= 1000");
  });

  test("unexpected arg → rc 1", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host: new StubHostCommandRunner(), sleep: async () => {},
    }, async () => "").run(["watch", "--nonsense"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("unexpected argument '--nonsense'");
  });
});

describe("TeamCommand.watch --once — single-tick catch-up (SessionStart hook use case)", () => {
  test("one tick with a Bear-addressed comment → stdout event line, rc 0, exits", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new StubHostCommandRunner();
    // First-poll's `since` is `now` from Date — we can't intercept
    // that easily, so seed a fallback for ANY since= query. The source
    // will call with an ISO of "now"; we don't know the exact value.
    // Instead: use the default runner outcome (rc 127) → poll-failed →
    // exercise the failure path OR pre-seed the store with a cursor.
    // We take the latter route: pre-seed store to a known cursor.
    const knownCursor = "2026-07-26T15:00:00.000Z";
    fs.seed("/home/alan/.config/dridock/watch-cursors/github.state.json",
      JSON.stringify({ cursor: knownCursor, delivered: [] }));
    seedGh(host, knownCursor, [
      { id: 1, body: "Arfy->Bear: verified", issue_url: "https://api.github.com/repos/aberezin/docker-claudebox/issues/42", updated_at: "2026-07-26T15:00:01Z" },
    ], []);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host, sleep: async () => {},
    }, async () => "").run(["watch", "--once"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("← Arfy: verified");
    expect(stdout.text()).toContain("github:#42#comment-1");
    // Config surface + no error on stderr
    expect(stderr.text()).toContain("self=Bear, repo=aberezin/docker-claudebox");
    expect(stderr.text()).not.toContain("poll failed");
  });

  test("--once with poll-failed → stderr warning, rc 0 (soft failure doesn't crash catchup)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    // No gh api seed → runner returns rc 127 → source returns poll-failed.
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host: new StubHostCommandRunner(), sleep: async () => {},
    }, async () => "").run(["watch", "--once"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("team watch: github poll failed");
  });

  test("--once writes heartbeat file (JSON)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    fs.seed("/home/alan/.config/dridock/watch-cursors/github.state.json",
      JSON.stringify({ cursor: "2026-07-26T15:00:00.000Z", delivered: [] }));
    seedGh(new StubHostCommandRunner(), "2026-07-26T15:00:00.000Z", [], []); // won't be used
    // Actually need a real runner for the poll — use one that returns empty:
    const host = new StubHostCommandRunner();
    seedGh(host, "2026-07-26T15:00:00.000Z", [], []);
    const { ctx } = makeCtx(fs);
    await new TeamCommand({
      git: new StubGitToplevel("/proj"), host, sleep: async () => {},
    }, async () => "").run(["watch", "--once"], ctx);
    const hb = await fs.readText("/home/alan/.config/dridock/watch-cursors/github.heartbeat");
    const parsed = JSON.parse(hb) as { source: string; kind: string; self: string; repo: string };
    expect(parsed.source).toBe("github");
    expect(parsed.kind).toBe("polled");
    expect(parsed.self).toBe("Bear");
    expect(parsed.repo).toBe("aberezin/docker-claudebox");
  });

  test("event addressed to OTHER agent → not surfaced (predicate composition E2E)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const cursor = "2026-07-26T15:00:00.000Z";
    fs.seed("/home/alan/.config/dridock/watch-cursors/github.state.json",
      JSON.stringify({ cursor, delivered: [] }));
    const host = new StubHostCommandRunner();
    seedGh(host, cursor, [
      { id: 1, body: "Arfy->Alan: for you", issue_url: "https://api.github.com/repos/aberezin/docker-claudebox/issues/42", updated_at: "2026-07-26T15:00:01Z" },
    ], []);
    const { ctx, stdout } = makeCtx(fs);
    await new TeamCommand({
      git: new StubGitToplevel("/proj"), host, sleep: async () => {},
    }, async () => "").run(["watch", "--once"], ctx);
    expect(stdout.text()).toBe(""); // no event surfaced
  });

  test("--repo flag overrides roster.githubRepo", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new StubHostCommandRunner();
    // Seed for a DIFFERENT repo — the override target.
    const cursor = "2026-07-26T15:00:00.000Z";
    fs.seed("/home/alan/.config/dridock/watch-cursors/github.state.json",
      JSON.stringify({ cursor, delivered: [] }));
    const encoded = encodeURIComponent(cursor);
    const overrideCommentsCmd = `gh api "repos/other/repo/issues/comments?since=${encoded}&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]?'`;
    const overrideIssuesCmd = `gh api "repos/other/repo/issues?since=${encoded}&state=all&sort=created&direction=asc" --paginate 2>/dev/null | jq -c '.[]? | select(.pull_request == null)'`;
    host.seedCommand(overrideCommentsCmd, 0, "");
    host.seedCommand(overrideIssuesCmd, 0, "");
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand({
      git: new StubGitToplevel("/proj"), host, sleep: async () => {},
    }, async () => "").run(["watch", "--once", "--repo", "other/repo"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("repo=other/repo");
    // If the override didn't apply, StubHostCommandRunner would return
    // rc 127 for the roster's URL → poll-failed. No failure → override worked.
    expect(stderr.text()).not.toContain("poll failed");
  });
});

describe("TeamCommand.watch (live loop) — env-var + arg mechanics", () => {
  test("DRIDOCK_WATCH_POLL_INTERVAL_MS env overrides default (via config surface line)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    setEnv("DRIDOCK_WATCH_POLL_INTERVAL_MS", "5000");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const cursor = "2026-07-26T15:00:00.000Z";
    fs.seed("/home/alan/.config/dridock/watch-cursors/github.state.json",
      JSON.stringify({ cursor, delivered: [] }));
    const host = new StubHostCommandRunner();
    seedGh(host, cursor, [], []);
    const { ctx, stderr } = makeCtx(fs);
    await new TeamCommand({
      git: new StubGitToplevel("/proj"), host, sleep: async () => {},
    }, async () => "").run(["watch", "--once"], ctx);
    // The interval is surfaced in the config-line — confirms env took effect.
    expect(stderr.text()).toContain("interval=5000ms");
  });
});

// Spec #59 part 1 — `dridock team <sub> --help` should print that
// subverb's usage instead of erroring. Also: --help must NOT require
// a project dir OR a resolvable roster (help is metadata about the
// command, not a state query). Every subverb + no roster present.
describe("TeamCommand — subverb --help intercept (spec #59 part 1)", () => {
  test("team post --help → post usage on stdout, rc=0, no roster needed", async () => {
    // No seedProject() call — proves --help doesn't need a roster.
    const { ctx, stdout, stderr } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["post", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team post");
    expect(stdout.text()).toContain("compose-only");
    // New in #59: --issue must be documented in post's --help.
    expect(stdout.text()).toContain("--issue");
    expect(stdout.text()).toContain("--dry-run");
    // Both paths (send + compose-only-with-pipe) must be documented.
    expect(stdout.text()).toContain("gh issue comment");
    // Not the misleading "unexpected argument '--help'" error.
    expect(stderr.text()).not.toContain("unexpected argument");
  });

  test("team post -h (short form) → same intercept", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["post", "-h"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team post");
  });

  test("team post --to Arfy --help → intercept fires even with other args present", async () => {
    // --help anywhere in the args wins — user typed a whole command
    // then remembered to ask for help.
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "body").run(["post", "--to", "Arfy", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team post");
    // The message body must NOT be composed — help wins.
    expect(stdout.text()).not.toContain("Bear->Arfy: body");
  });

  test("team watch --help → watch usage on stdout, includes --inbox", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["watch", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team watch");
    expect(stdout.text()).toContain("--inbox");
    expect(stdout.text()).toContain("fetcher mode");
  });

  test("team fetcher --help → fetcher usage on stdout, lists status/stop/log", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["fetcher", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team fetcher");
    expect(stdout.text()).toContain("status");
    expect(stdout.text()).toContain("stop");
    expect(stdout.text()).toContain("log");
  });

  test("team fetcher status --help → fetcher usage (aggregate covers sub-subverbs)", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["fetcher", "status", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team fetcher");
  });

  test("team whoami --help → whoami usage on stdout", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["whoami", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team whoami");
  });

  test("team roster --help → roster usage on stdout", async () => {
    const { ctx, stdout } = makeCtx(new InMemoryFileSystem());
    const rc = await new TeamCommand({ git: new StubGitToplevel("/proj") }, async () => "").run(["roster", "--help"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toContain("usage: dridock team roster");
  });
});

// Spec #59 part 3 — TTY-detect for `team post`. When stdout is a
// terminal (nothing consuming the composed output), print a stderr
// hint so the operator sees "compose-only" at the exact moment of
// the mistake. Same silent-degrade class as #56 findings.
describe("TeamCommand.post — TTY-detect hint (spec #59 part 3)", () => {
  test("stdout is TTY → stderr hint fires + shows the pipe pattern", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), stdoutIsTTY: () => true },
      async () => "hello\n",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(0);
    // Compose still happens — the hint is informational, not an error.
    expect(stdout.text()).toBe("Bear->Arfy: hello\n");
    // But stderr now tells the operator this was compose-only.
    expect(stderr.text()).toContain("COMPOSE-ONLY");
    expect(stderr.text()).toContain("nothing was sent");
    expect(stderr.text()).toContain("gh issue comment");
  });

  test("stdout is NOT TTY (piped) → no hint (silent success is correct)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), stdoutIsTTY: () => false },
      async () => "hello\n",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear->Arfy: hello\n");
    // stderr must NOT contain the hint — a piped invocation is the
    // correct pattern and would be noise every time.
    expect(stderr.text()).not.toContain("COMPOSE-ONLY");
    expect(stderr.text()).not.toContain("nothing was sent");
  });

  test("TTY hint also fires on broadcast (no --to)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), stdoutIsTTY: () => true },
      async () => "broadcast\n",
    ).run(["post"], ctx);
    expect(rc).toBe(0);
    expect(stderr.text()).toContain("COMPOSE-ONLY");
  });

  test("empty stdin under TTY → rc 1 (rejection, not compose-only hint — #59)", async () => {
    // Was previously "TTY hint fires even for empty stdin" — under
    // the body-sanity gate added in #59, empty stdin now rejects
    // BEFORE the TTY-hint branch is reached. That's the right shape:
    // an interactive operator expecting SOMETHING to happen gets a
    // loud rejection ("body is empty") rather than a warning-and-
    // header-only-emit that reads as partial success.
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), stdoutIsTTY: () => true },
      async () => "",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("body is empty");
    // COMPOSE-ONLY hint must NOT fire — rejection is the signal.
    expect(stderr.text()).not.toContain("COMPOSE-ONLY");
  });
});

/** Test-local runner that records every `runCapture` call and returns
 *  a canned rc/stdout. Kept inline (not added to StubHostCommandRunner)
 *  because the send-path tests need to inspect the *dynamic* temp path
 *  in each call, which the exact-string map in `StubHostCommandRunner`
 *  can't match. */
class RecordingHostRunner {
  readonly calls: string[] = [];
  constructor(private readonly rc = 0, private readonly stdout = "") {}
  async runCapture(cmd: string): Promise<{ rc: number; stdout: string }> {
    this.calls.push(cmd);
    return { rc: this.rc, stdout: this.stdout };
  }
}

describe("TeamCommand.post — send path (--issue, --repo, --dry-run) — #59", () => {
  test("--issue with roster.github_repo → invokes gh with correct repo + temp body-file", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner(0, "https://github.com/aberezin/docker-claudebox/issues/59#issuecomment-9999\n");
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "verified end-to-end\n",
    ).run(["post", "--to", "Arfy", "--issue", "59"], ctx);
    expect(rc).toBe(0);
    // Exactly one gh invocation.
    expect(host.calls).toHaveLength(1);
    // Correct issue, repo from roster, body-file present (path is
    // dynamic — assert on shape, not exact string).
    expect(host.calls[0]).toContain("gh issue comment 59");
    expect(host.calls[0]).toContain("--repo 'aberezin/docker-claudebox'");
    expect(host.calls[0]).toMatch(/--body-file '[^']+pending-post-\d+-\d+\.md'/);
    // Success line names repo + issue + URL from gh's stdout.
    expect(stdout.text()).toContain("✅ team post: sent to aberezin/docker-claudebox#59");
    expect(stdout.text()).toContain("issuecomment-9999");
    expect(stderr.text()).toBe("");
  });

  test("--issue with --repo override → uses override, not roster", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner(0, "");
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "cross-repo post\n",
    ).run(["post", "--to", "Arfy", "--issue", "42", "--repo", "aberezin/other-repo"], ctx);
    expect(rc).toBe(0);
    expect(host.calls[0]).toContain("--repo 'aberezin/other-repo'");
    expect(host.calls[0]).not.toContain("docker-claudebox");
    expect(stdout.text()).toContain("aberezin/other-repo#42");
  });

  test("--issue but no roster.github_repo AND no --repo → rc 1, gh not invoked", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs); // roster WITHOUT github_repo
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body content\n",
    ).run(["post", "--to", "Arfy", "--issue", "1"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("no GitHub repo configured");
  });

  test("--issue with malformed --repo → rc 1, gh not invoked", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--issue", "1", "--repo", "not-a-repo"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("invalid repo 'not-a-repo'");
  });

  test("--issue with non-numeric value → rc 1, gh not invoked", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--issue", "abc"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("--issue must be a positive integer, got 'abc'");
  });

  test("--issue with zero → rc 1 (positive integer required)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--issue", "0"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("--issue must be a positive integer");
  });

  test("gh failure (non-zero rc) → propagates rc, error line names the failure", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    setEnv("XDG_CONFIG_HOME", "/home/alan/.config");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner(4, ""); // gh's typical auth-error rc
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--issue", "42"], ctx);
    expect(rc).toBe(4); // rc propagated verbatim
    expect(host.calls).toHaveLength(1); // gh WAS invoked
    expect(stderr.text()).toContain("gh issue comment failed with rc=4");
  });

  test("--dry-run with --issue → prints composed text, does NOT invoke gh", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "dry-run body\n",
    ).run(["post", "--to", "Arfy", "--issue", "42", "--dry-run"], ctx);
    expect(rc).toBe(0);
    expect(host.calls).toHaveLength(0); // gh MUST NOT be invoked
    expect(stdout.text()).toContain("Bear->Arfy: dry-run body");
    expect(stderr.text()).toContain("--dry-run");
    expect(stderr.text()).toContain("would send to aberezin/docker-claudebox#42");
    expect(stderr.text()).toContain("no request made");
  });

  test("--dry-run also validates repo (dry-run of a bad repo still fails loud)", async () => {
    // Rationale on the impl-side comment: a dry-run that green-lights a
    // send that would then fail on repo resolution is a lie.
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--issue", "42", "--repo", "bad!!repo", "--dry-run"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("invalid repo");
  });

  test("--dry-run without --issue → rc 1 (compose-only is already the default without --issue)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--dry-run"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("--dry-run requires --issue");
  });

  test("--repo without --issue → rc 1 (repo has nothing to point at)", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "body\n",
    ).run(["post", "--to", "Arfy", "--repo", "aberezin/other"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("--repo requires --issue");
  });
});

describe("TeamCommand.post — body sanity gate (#59)", () => {
  test("body of literal '@-' (the historical incident) → rc 1, no compose", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "@-",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("no alphanumeric content");
    // Names the historical incident so the operator can look it up.
    expect(stderr.text()).toContain("#56");
  });

  test("body of only punctuation ('?!') → rc 1", async () => {
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "?!\n",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("no alphanumeric content");
  });

  test("body of only whitespace → rc 1 with 'body is empty'", async () => {
    // trim() collapses whitespace-only to "".
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj") },
      async () => "  \n\t\n",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(1);
    expect(stderr.text()).toContain("body is empty");
  });

  test("body 'ok' (2 chars, alphanumeric) → ACCEPTED (short legit messages must pass)", async () => {
    // Explicitly guards against a naive length-based check that would
    // reject "ok", "hi", "no" — all of which are legitimate replies.
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs);
    const { ctx, stdout } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), stdoutIsTTY: () => false },
      async () => "ok\n",
    ).run(["post", "--to", "Arfy"], ctx);
    expect(rc).toBe(0);
    expect(stdout.text()).toBe("Bear->Arfy: ok\n");
  });

  test("body sanity gate ALSO fires on send path (--issue), not just compose-only", async () => {
    // Otherwise `--to X < broken-body` would be a working dev loop
    // that silently breaks the moment --issue is added.
    setEnv("DRIDOCK_AGENT_NAME", "Bear");
    const fs = new InMemoryFileSystem();
    seedProject(fs, ROSTER_WITH_REPO);
    const host = new RecordingHostRunner();
    const { ctx, stderr } = makeCtx(fs);
    const rc = await new TeamCommand(
      { git: new StubGitToplevel("/proj"), host },
      async () => "@-",
    ).run(["post", "--to", "Arfy", "--issue", "42"], ctx);
    expect(rc).toBe(1);
    expect(host.calls).toHaveLength(0);
    expect(stderr.text()).toContain("no alphanumeric content");
  });
});

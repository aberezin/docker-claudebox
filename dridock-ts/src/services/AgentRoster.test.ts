import { test, expect, describe } from "bun:test";
import {
  parseRoster,
  loadRoster,
  resolveSelfName,
  formatResolveError,
  soleAgentByEnvironment,
} from "./AgentRoster.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

// Spec: docs/design/agent-teams.md §1 (identity/roster).

describe("parseRoster — the canonical shape from spec §1", () => {
  test("full example from spec: Bear + Arfy + Alan the human", () => {
    const yaml = `# .dridock/agents.yml — the team working this project
agents:
  - name: Bear
    role: principal-engineer
    environment: container
  - name: Arfy
    role: senior-qa
    environment: host-macos
human: Alan
`;
    const r = parseRoster(yaml);
    expect(r).toEqual({
      agents: [
        { name: "Bear", role: "principal-engineer", environment: "container" },
        { name: "Arfy", role: "senior-qa", environment: "host-macos" },
      ],
      human: "Alan",
    });
  });

  test("minimal roster: single agent, no human, no roles", () => {
    const r = parseRoster(`agents:\n  - name: Solo\n`);
    expect(r).toEqual({ agents: [{ name: "Solo" }] });
    expect(r.human).toBeUndefined();
  });

  test("role or environment can be omitted per-agent (both optional)", () => {
    const r = parseRoster(`agents:\n  - name: Bear\n    role: eng\n  - name: Arfy\n    environment: host\n`);
    expect(r.agents).toEqual([
      { name: "Bear", role: "eng" },
      { name: "Arfy", environment: "host" },
    ]);
  });

  test("human can appear before or after agents block", () => {
    const before = parseRoster(`human: Alan\nagents:\n  - name: Bear\n`);
    const after = parseRoster(`agents:\n  - name: Bear\nhuman: Alan\n`);
    expect(before.human).toBe("Alan");
    expect(after.human).toBe("Alan");
  });

  test("blank lines and full-line comments are skipped", () => {
    const r = parseRoster(`# top comment
agents:

  # inline comment
  - name: Bear
    role: eng

  - name: Arfy
`);
    expect(r.agents).toEqual([{ name: "Bear", role: "eng" }, { name: "Arfy" }]);
  });

  test("inline # comments are stripped from values", () => {
    const r = parseRoster(`agents:\n  - name: Bear # my name\n    role: eng # my role\nhuman: Alan  # the human\n`);
    expect(r.agents[0]).toEqual({ name: "Bear", role: "eng" });
    expect(r.human).toBe("Alan");
  });

  test("value-starting-with-# is treated as empty (bash-parity with parseNestedYaml)", () => {
    const r = parseRoster(`agents:\n  - name: Bear\nhuman: # optional\n`);
    expect(r.human).toBeUndefined();
  });

  test("github_repo top-level key parses (added #46.d.3b for `team watch`)", () => {
    const r = parseRoster(`agents:\n  - name: Bear\ngithub_repo: aberezin/docker-claudebox\n`);
    expect(r.githubRepo).toBe("aberezin/docker-claudebox");
  });

  test("github_repo can appear before or after agents, and is optional", () => {
    const before = parseRoster(`github_repo: owner/name\nagents:\n  - name: Bear\n`);
    const after = parseRoster(`agents:\n  - name: Bear\ngithub_repo: owner/name\n`);
    const none = parseRoster(`agents:\n  - name: Bear\n`);
    expect(before.githubRepo).toBe("owner/name");
    expect(after.githubRepo).toBe("owner/name");
    expect(none.githubRepo).toBeUndefined();
  });
});

describe("parseRoster — fail-loud on malformed input", () => {
  test("empty roster (no agents) → throws", () => {
    expect(() => parseRoster(`human: Alan\n`)).toThrow("at least one agent");
  });

  test("agent item without a 'name:' field → throws with line info missing? (just needs the name error)", () => {
    expect(() => parseRoster(`agents:\n  - role: eng\n`)).toThrow("without a 'name:' field");
  });

  test("unknown top-level key → throws", () => {
    expect(() => parseRoster(`bogus: value\nagents:\n  - name: Bear\n`)).toThrow("unknown top-level key 'bogus'");
  });

  test("unknown agent field → throws with line info", () => {
    expect(() => parseRoster(`agents:\n  - name: Bear\n    handle: bear1\n`)).toThrow(/line 3.*unknown agent field 'handle'/);
  });

  test("duplicate agent names → throws (spec §1: names are the identity)", () => {
    expect(() => parseRoster(`agents:\n  - name: Bear\n  - name: Bear\n`)).toThrow("duplicate agent name 'Bear'");
  });

  test("agents: with an inline value → throws (must open a list)", () => {
    expect(() => parseRoster(`agents: [Bear, Arfy]\n`)).toThrow("must open a list");
  });

  test("garbage at column 0 → throws", () => {
    expect(() => parseRoster(`this is not yaml at all\n`)).toThrow(/expected 'key: value'/);
  });

  test("indented content outside agents: → throws", () => {
    expect(() => parseRoster(`  - name: Bear\n`)).toThrow("unexpected indent");
  });

  test("continuation field before any list item → throws", () => {
    expect(() => parseRoster(`agents:\n    role: orphan\n`)).toThrow(/expected list item/);
  });
});

describe("loadRoster — filesystem-integrated", () => {
  test("file present → parsed roster", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/proj/.dridock/agents.yml", `agents:\n  - name: Bear\n    environment: container\n`);
    const r = await loadRoster(fs, "/proj/.dridock/agents.yml");
    expect(r).toEqual({ agents: [{ name: "Bear", environment: "container" }] });
  });

  test("file absent → undefined (caller decides what to do)", async () => {
    const fs = new InMemoryFileSystem();
    const r = await loadRoster(fs, "/proj/.dridock/agents.yml");
    expect(r).toBeUndefined();
  });
});

describe("resolveSelfName — env-first with single-agent fallback", () => {
  const roster = {
    agents: [
      { name: "Bear", environment: "container" as const },
      { name: "Arfy", environment: "host-macos" as const },
    ],
  };
  const soloRoster = { agents: [{ name: "Solo" }] };

  test("env is set + in roster → returns env value, source='env'", () => {
    const r = resolveSelfName({ DRIDOCK_AGENT_NAME: "Bear" }, roster);
    expect(r).toEqual({ selfName: "Bear", source: "env" });
  });

  test("env unset + single-agent roster → returns that name, source='roster-single-agent'", () => {
    const r = resolveSelfName({}, soloRoster);
    expect(r).toEqual({ selfName: "Solo", source: "roster-single-agent" });
  });

  test("env unset + multi-agent roster → error (ambiguous, must be explicit)", () => {
    const r = resolveSelfName({}, roster);
    expect(r).toEqual({ kind: "no-env-and-multi-agent", candidates: ["Bear", "Arfy"] });
  });

  test("env EMPTY string + single-agent roster → uses fallback (empty is treated as unset)", () => {
    const r = resolveSelfName({ DRIDOCK_AGENT_NAME: "" }, soloRoster);
    expect(r).toEqual({ selfName: "Solo", source: "roster-single-agent" });
  });

  test("env set but NOT in roster → error listing valid names", () => {
    const r = resolveSelfName({ DRIDOCK_AGENT_NAME: "Ghost" }, roster);
    expect(r).toEqual({ kind: "env-not-in-roster", envValue: "Ghost", rosterNames: ["Bear", "Arfy"] });
  });
});

describe("soleAgentByEnvironment — for StartCommand auto-inject", () => {
  test("single agent with matching environment → returns that name", () => {
    const r = {
      agents: [
        { name: "Bear", environment: "container" as const },
        { name: "Arfy", environment: "host-macos" as const },
      ],
    };
    expect(soleAgentByEnvironment(r, "container")).toBe("Bear");
    expect(soleAgentByEnvironment(r, "host-macos")).toBe("Arfy");
  });

  test("zero matches → undefined", () => {
    const r = { agents: [{ name: "Solo", environment: "container" as const }] };
    expect(soleAgentByEnvironment(r, "does-not-exist")).toBeUndefined();
  });

  test("multiple matches → undefined (ambiguous, skip auto-inject)", () => {
    const r = {
      agents: [
        { name: "Bear1", environment: "container" as const },
        { name: "Bear2", environment: "container" as const },
      ],
    };
    expect(soleAgentByEnvironment(r, "container")).toBeUndefined();
  });

  test("agents with no environment field → not counted", () => {
    const r = {
      agents: [
        { name: "Bear", environment: "container" as const },
        { name: "Anon" }, // no environment
      ],
    };
    expect(soleAgentByEnvironment(r, "container")).toBe("Bear");
  });
});

describe("formatResolveError — stderr messages", () => {
  test("no-env-and-multi-agent lists candidates and points at both host + container fix paths", () => {
    const lines = formatResolveError(
      { kind: "no-env-and-multi-agent", candidates: ["Bear", "Arfy"] },
      "/proj/.dridock/agents.yml",
    );
    const text = lines.join("");
    expect(text).toContain("DRIDOCK_AGENT_NAME is unset");
    expect(text).toContain("Bear, Arfy");
    expect(text).toContain("~/.zshrc");     // host fix path
    expect(text).toContain("DRIDOCK_ENV_"); // container fix path
  });

  test("env-not-in-roster lists valid names and where to add if intended", () => {
    const lines = formatResolveError(
      { kind: "env-not-in-roster", envValue: "Ghost", rosterNames: ["Bear", "Arfy"] },
      "/proj/.dridock/agents.yml",
    );
    const text = lines.join("");
    expect(text).toContain("'Ghost' isn't in the roster");
    expect(text).toContain("Bear, Arfy");
    expect(text).toContain("/proj/.dridock/agents.yml");
  });

  test("roster-missing points at spec §1 for the schema", () => {
    const lines = formatResolveError(
      { kind: "roster-missing", configPath: "/proj/.dridock/agents.yml" },
      "/proj/.dridock/agents.yml",
    );
    const text = lines.join("");
    expect(text).toContain("no roster at /proj/.dridock/agents.yml");
    expect(text).toContain("agent-teams.md §1");
  });
});

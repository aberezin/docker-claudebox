import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Roster loader for `.dridock/agents.yml` — the per-project team
 * declaration per agent-teams.md §1.
 *
 * Zero-dep hand-rolled YAML parser for THIS specific shape only (list
 * of agent maps + optional scalar `human:`). Matches the parser
 * philosophy already used in `ProjectConfig.ts` (parseTopLevelString /
 * parseNestedYaml) rather than pulling in js-yaml. If the schema grows
 * beyond what a 40-line parser can handle, switch to `Bun.YAML.parse`
 * or `js-yaml` — both fit; the interface stays.
 *
 * Expected on-disk shape (per spec §1):
 * ```yaml
 * agents:
 *   - name: Bear
 *     role: principal-engineer
 *     environment: container
 *   - name: Arfy
 *     role: senior-qa
 *     environment: host-macos
 * human: Alan
 * ```
 */

export interface Agent {
  readonly name: string;
  readonly role?: string;
  readonly environment?: string;
}

export interface Roster {
  readonly agents: readonly Agent[];
  readonly human?: string;
  /** Optional watch config — the GitHub repo `dridock team watch`
   *  polls for this team's messages. Format: `owner/name`. If unset,
   *  `team watch` requires `--repo` on the command line. Added for
   *  #46.d.3b; distinct from `.dridock/config.yml` `id`/`vm`/etc. */
  readonly githubRepo?: string;
}

export interface RosterResolveResult {
  readonly selfName: string;
  /** Where the name came from — for diagnostics + audit-rule logging. */
  readonly source: "env" | "roster-single-agent";
}

export type RosterResolveError =
  | { readonly kind: "roster-missing"; readonly configPath: string }
  | { readonly kind: "no-env-and-multi-agent"; readonly candidates: readonly string[] }
  | { readonly kind: "env-not-in-roster"; readonly envValue: string; readonly rosterNames: readonly string[] };

/** Load and parse `.dridock/agents.yml` at `configPath`. Returns
 *  `undefined` if the file doesn't exist. Throws on malformed content
 *  (fail-loud — a mis-authored roster is a user-input error the caller
 *  needs to surface, not paper over). */
export async function loadRoster(fs: FileSystem, configPath: string): Promise<Roster | undefined> {
  const text = await fs.readTextOrUndefined(configPath);
  if (text === undefined) return undefined;
  return parseRoster(text);
}

/**
 * Resolve the agent name for THIS runtime — either from
 * `DRIDOCK_AGENT_NAME` env (authoritative when set) or by falling back
 * to a single-agent roster (unambiguous).
 *
 * Precedence:
 *   1. `DRIDOCK_AGENT_NAME` env is set + non-empty → validate against
 *      roster (must exist) → return.
 *   2. Env unset AND roster has exactly one agent → use that agent.
 *   3. Anything else → error (multi-agent roster + no env = ambiguous
 *      by construction; user must be explicit).
 *
 * "Set the env" is the answer for both Arfy (shell rc, macOS-host) and
 * Bear (container entrypoint / sidecar). The single-agent fallback is
 * for solo projects that don't feel the need to declare the env yet.
 */
export function resolveSelfName(
  env: Record<string, string | undefined>,
  roster: Roster,
): RosterResolveResult | RosterResolveError {
  const envValue = env["DRIDOCK_AGENT_NAME"];
  if (envValue !== undefined && envValue !== "") {
    if (!roster.agents.some((a) => a.name === envValue)) {
      return {
        kind: "env-not-in-roster",
        envValue,
        rosterNames: roster.agents.map((a) => a.name),
      };
    }
    return { selfName: envValue, source: "env" };
  }
  if (roster.agents.length === 1) {
    return { selfName: roster.agents[0]!.name, source: "roster-single-agent" };
  }
  return {
    kind: "no-env-and-multi-agent",
    candidates: roster.agents.map((a) => a.name),
  };
}

/**
 * Format a `RosterResolveError` as a human-facing multi-line message
 * for stderr. Callers pass this to `ctx.stderr.write` when they hit
 * the error branch. Kept out of `resolveSelfName` so the pure function
 * stays testable + composable.
 */
export function formatResolveError(err: RosterResolveError, configPath: string): string[] {
  switch (err.kind) {
    case "roster-missing":
      return [
        `❌ agent-teams: no roster at ${err.configPath}\n`,
        `   Create .dridock/agents.yml declaring your team (see docs/design/agent-teams.md §1).\n`,
      ];
    case "no-env-and-multi-agent":
      return [
        `❌ agent-teams: DRIDOCK_AGENT_NAME is unset and the roster has multiple agents:\n`,
        `     ${err.candidates.join(", ")}\n`,
        `   Set DRIDOCK_AGENT_NAME to one of the above so this runtime knows which agent it is.\n`,
        `   (Host: export DRIDOCK_AGENT_NAME=<name> in ~/.zshrc or ~/.bashrc.\n`,
        `    Container: set it in the entrypoint or via DRIDOCK_ENV_DRIDOCK_AGENT_NAME on start.)\n`,
      ];
    case "env-not-in-roster":
      return [
        `❌ agent-teams: DRIDOCK_AGENT_NAME='${err.envValue}' isn't in the roster.\n`,
        `   Roster has: ${err.rosterNames.join(", ")} — pick one, or add '${err.envValue}' to ${configPath}.\n`,
      ];
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Internals — the hand-rolled YAML parser for THIS shape only.
 * ─────────────────────────────────────────────────────────────────────
 */

/**
 * Parse the `.dridock/agents.yml` text. Extracted from `loadRoster`
 * for direct unit-testing without needing to seed a FileSystem.
 *
 * Grammar covered (deliberately narrow):
 *   - `key: value` at column 0 (top-level scalar OR container header)
 *   - `agents:` opens a list; items start with `  - key: value` and
 *     continue with `    key: value` at deeper indent
 *   - values with a leading `#` are treated as empty (matches
 *     ProjectConfig's parseNestedYaml convention)
 *   - blank + comment lines skipped
 *
 * Anything else (nested containers other than agents/agent-items,
 * flow-style, multi-line strings) throws — spec §1 doesn't need them
 * and silently accepting would hide typos.
 */
export function parseRoster(text: string): Roster {
  const lines = text.split(/\r?\n/);
  const agents: Agent[] = [];
  let human: string | undefined;
  let githubRepo: string | undefined;
  let inAgents = false;
  let currentAgent: Partial<Agent> | undefined;

  const finishAgent = (): void => {
    if (currentAgent !== undefined) {
      if (currentAgent.name === undefined || currentAgent.name === "") {
        throw new Error(`agents.yml: agent item without a 'name:' field`);
      }
      agents.push(currentAgent as Agent);
      currentAgent = undefined;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    // Skip blank + full-line comments.
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;

    // Top-level key (column 0).
    if (indent === 0) {
      finishAgent();
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
      if (m === null) {
        throw new Error(`agents.yml: line ${i + 1}: expected 'key: value' at column 0, got: ${raw}`);
      }
      const key = m[1]!;
      const value = stripInlineComment(m[2]!);
      if (key === "agents") {
        if (value !== "") {
          throw new Error(`agents.yml: line ${i + 1}: 'agents:' must open a list on subsequent lines, not have an inline value`);
        }
        inAgents = true;
      } else if (key === "human") {
        human = value === "" ? undefined : value;
        inAgents = false;
      } else if (key === "github_repo") {
        githubRepo = value === "" ? undefined : value;
        inAgents = false;
      } else {
        throw new Error(`agents.yml: line ${i + 1}: unknown top-level key '${key}' (allowed: agents, human, github_repo)`);
      }
      continue;
    }

    // Indented — only meaningful inside 'agents:'.
    if (!inAgents) {
      throw new Error(`agents.yml: line ${i + 1}: unexpected indent outside 'agents:'`);
    }

    // List-item start: '  - key: value'
    const itemMatch = /^\s+-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (itemMatch !== null) {
      finishAgent();
      currentAgent = {};
      setAgentField(currentAgent, itemMatch[1]!, stripInlineComment(itemMatch[2]!), i + 1);
      continue;
    }

    // Continuation of current item: '    key: value'
    if (currentAgent === undefined) {
      throw new Error(`agents.yml: line ${i + 1}: expected list item ('  - name: X') before continuation fields`);
    }
    const contMatch = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (contMatch === null) {
      throw new Error(`agents.yml: line ${i + 1}: expected 'key: value' agent field, got: ${raw}`);
    }
    setAgentField(currentAgent, contMatch[1]!, stripInlineComment(contMatch[2]!), i + 1);
  }
  finishAgent();

  if (agents.length === 0) {
    throw new Error(`agents.yml: roster must declare at least one agent under 'agents:'`);
  }
  // Deduplication check — same name twice is almost certainly a user error.
  const seen = new Set<string>();
  for (const a of agents) {
    if (seen.has(a.name)) {
      throw new Error(`agents.yml: duplicate agent name '${a.name}'`);
    }
    seen.add(a.name);
  }
  return {
    agents,
    ...(human !== undefined ? { human } : {}),
    ...(githubRepo !== undefined ? { githubRepo } : {}),
  };
}

function setAgentField(agent: Partial<Agent>, key: string, value: string, lineNum: number): void {
  switch (key) {
    case "name": (agent as { name?: string }).name = value; break;
    case "role": (agent as { role?: string }).role = value; break;
    case "environment": (agent as { environment?: string }).environment = value; break;
    default:
      throw new Error(`agents.yml: line ${lineNum}: unknown agent field '${key}' (allowed: name, role, environment)`);
  }
}

/**
 * Strip an inline `# comment` from a value. Mirrors ProjectConfig's
 * `parseNestedYaml` behavior — a value starting with `#` is treated
 * as empty (matches the `hostname: # optional` convention). Trailing
 * whitespace also trimmed.
 */
function stripInlineComment(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return "";
  const hashAt = trimmed.indexOf(" #");
  return (hashAt === -1 ? trimmed : trimmed.substring(0, hashAt)).trim();
}

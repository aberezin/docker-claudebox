import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { loadRoster, resolveSelfName, formatResolveError, type Roster } from "../../services/AgentRoster.ts";
import { formatHeader } from "../../services/AgentTeamHeader.ts";

/**
 * `dridock team <sub>` — inspect + post to the project's agent team
 * (spec: docs/design/agent-teams.md, this project's `.dridock/agents.yml`).
 *
 * Sub-verbs:
 *   whoami                → resolve THIS runtime's agent name (via
 *                           DRIDOCK_AGENT_NAME env, or single-agent
 *                           fallback) and print it
 *   roster                → print the whole team (agents + human)
 *   post [--to A,B]       → prepend the sender header to stdin, print
 *                           to stdout (broadcast if --to is omitted)
 *
 * Read-only for the roster file — writes go through `bootstrap` or a
 * hand edit. `post` doesn't hit the network; it just formats. Piping
 * to `gh issue comment --body-file -` is the intended use.
 *
 * `watch` is deferred to a later #46 slice — the watcher is the
 * biggest piece and lands on top of #45's event schema (channel-less
 * polling per ADR-0001).
 */
export class TeamCommand implements Command {
  readonly verb = "team" as const;

  constructor(
    private readonly deps: Partial<TeamCommandDeps> = {},
    /** Injected in tests to avoid touching `process.stdin`. */
    private readonly readStdinFn: () => Promise<string> = defaultReadStdin,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0];
    if (sub === undefined || sub === "" || sub === "-h" || sub === "--help") {
      this.printUsage(ctx);
      return sub === "-h" || sub === "--help" ? 0 : 1;
    }
    if (sub !== "whoami" && sub !== "roster" && sub !== "post") {
      ctx.stderr.write(`❌ team: unknown subcommand '${sub}' (allowed: whoami, roster, post)\n`);
      return 1;
    }

    // All three subcommands need the roster loaded. Resolve project +
    // roster path first; missing roster is a distinct clear error.
    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const rosterPath = `${project.dotDir}/agents.yml`;
    let roster: Roster | undefined;
    try {
      roster = await loadRoster(ctx.fs, rosterPath);
    } catch (e) {
      ctx.stderr.write(`❌ team: malformed roster at ${rosterPath}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (roster === undefined) {
      for (const line of formatResolveError({ kind: "roster-missing", configPath: rosterPath }, rosterPath)) {
        ctx.stderr.write(line);
      }
      return 1;
    }

    if (sub === "roster") return this.runRoster(roster, ctx);

    // `whoami` and `post` both need selfName resolution.
    const resolved = resolveSelfName(process.env, roster);
    if ("kind" in resolved) {
      for (const line of formatResolveError(resolved, rosterPath)) ctx.stderr.write(line);
      return 1;
    }

    if (sub === "whoami") return this.runWhoami(resolved.selfName, resolved.source, ctx);
    return await this.runPost(args.slice(1), resolved.selfName, roster, ctx);
  }

  private runWhoami(selfName: string, source: "env" | "roster-single-agent", ctx: Context): number {
    ctx.stdout.write(`${selfName}\n`);
    // Diagnostic on stderr so `dridock team whoami` remains pipe-clean
    // for scripts (`SELF=$(dridock team whoami)`).
    ctx.stderr.write(`  (from ${source === "env" ? "DRIDOCK_AGENT_NAME env" : "single-agent roster fallback"})\n`);
    return 0;
  }

  private runRoster(roster: Roster, ctx: Context): number {
    ctx.stdout.write(`team roster:\n`);
    ctx.stdout.write(`  agents:\n`);
    for (const a of roster.agents) {
      const meta: string[] = [];
      if (a.role !== undefined) meta.push(`role=${a.role}`);
      if (a.environment !== undefined) meta.push(`env=${a.environment}`);
      const suffix = meta.length > 0 ? `  (${meta.join(", ")})` : "";
      ctx.stdout.write(`    - ${a.name}${suffix}\n`);
    }
    if (roster.human !== undefined) {
      ctx.stdout.write(`  human: ${roster.human}\n`);
    }
    return 0;
  }

  private async runPost(args: readonly string[], selfName: string, roster: Roster, ctx: Context): Promise<number> {
    // Parse `--to A,B` (single value; repeat not supported — comma-list
    // is the canonical form per spec §2). Anything else is unexpected.
    let toRaw: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--to") {
        toRaw = args[i + 1];
        i++;
        continue;
      }
      if (a?.startsWith("--to=")) {
        toRaw = a.slice("--to=".length);
        continue;
      }
      ctx.stderr.write(`❌ team post: unexpected argument '${a}' (allowed: --to <A,B>)\n`);
      return 1;
    }

    // Recipient validation: every name must be in the roster (agents +
    // human) so we catch typos before posting. Fail-loud rather than
    // sending "Bear->Alanm:" and having the watcher silently drop it.
    const recipients = toRaw === undefined || toRaw === "" ? [] : toRaw.split(",").map((r) => r.trim());
    if (recipients.length > 0) {
      const knownNames = new Set<string>(roster.agents.map((a) => a.name));
      if (roster.human !== undefined) knownNames.add(roster.human);
      for (const r of recipients) {
        if (!knownNames.has(r)) {
          ctx.stderr.write(`❌ team post: '${r}' isn't in the roster.\n`);
          ctx.stderr.write(`   Roster has: ${[...knownNames].join(", ")}\n`);
          return 1;
        }
      }
    }

    // Compose the header, read stdin, emit `<header> <body>` on stdout.
    // No trailing newline added — the stdin content owns its shape.
    let header: string;
    try {
      header = formatHeader(selfName, recipients);
    } catch (e) {
      ctx.stderr.write(`❌ team post: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const body = await this.readStdinFn();
    // If stdin is empty, still emit the header alone — user may want
    // just the salutation for a follow-up edit. Keep behavior explicit.
    if (body === "") {
      ctx.stdout.write(`${header}\n`);
    } else {
      // Same-line header + body if body starts with content, blank-line
      // separator if body is multi-paragraph — matches how humans write
      // it in the tracker. Simplest deterministic rule: single newline
      // between header and body.
      ctx.stdout.write(`${header} ${body.startsWith("\n") ? body.trimStart() : body}`);
      if (!body.endsWith("\n")) ctx.stdout.write(`\n`);
    }
    return 0;
  }

  private printUsage(ctx: Context): void {
    ctx.stderr.write(`usage: ${ctx.binName} team <subcommand>\n`);
    ctx.stderr.write(`  Named-agent team collaboration (docs/design/agent-teams.md).\n`);
    ctx.stderr.write(`\n`);
    ctx.stderr.write(`Subcommands:\n`);
    ctx.stderr.write(`  whoami                THIS runtime's agent name (from DRIDOCK_AGENT_NAME env\n`);
    ctx.stderr.write(`                        or single-agent roster fallback)\n`);
    ctx.stderr.write(`  roster                the whole team (agents + human) from .dridock/agents.yml\n`);
    ctx.stderr.write(`  post [--to A,B]       prepend the sender header to stdin, print to stdout\n`);
    ctx.stderr.write(`                        (broadcast if --to omitted). Pipe into gh issue comment.\n`);
  }
}

export interface TeamCommandDeps {
  readonly git: GitToplevel;
}

/** Read stdin exhaustively into a string. Returns "" if stdin is a TTY
 *  (interactive, no piped input) or empty. Matches BootstrapCommand's
 *  `defaultReadStdin` shape — same pattern, same reason (testability). */
async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  return chunks.join("");
}

import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { HostCommandRunner } from "../../infra/HostCommandRunner.ts";
import { RealHostCommandRunner } from "../../infra/HostCommandRunner.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { loadRoster, resolveSelfName, formatResolveError, type Roster } from "../../services/AgentRoster.ts";
import { formatHeader } from "../../services/AgentTeamHeader.ts";
import { GithubWatchSource } from "../../services/GithubWatchSource.ts";
import { WatcherStore } from "../../services/WatcherStore.ts";
import { runOneTick, type WatcherSink, type WatcherTickSummary } from "../../services/WatcherLoop.ts";
import { xdgRoot } from "../../domain/paths.ts";

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
    if (sub !== "whoami" && sub !== "roster" && sub !== "post" && sub !== "watch") {
      ctx.stderr.write(`❌ team: unknown subcommand '${sub}' (allowed: whoami, roster, post, watch)\n`);
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
    if (sub === "watch") return await this.runWatch(args.slice(1), resolved.selfName, roster, ctx);
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

  /**
   * `dridock team watch` — poll GitHub for messages addressed to
   * SELF, surface each survived event on stdout. Live loop by default;
   * `--once` for the SessionStart-hook catch-up use case.
   *
   * Composes the primitives + orchestrator from #46.d.1/.2/.3a:
   *   - `GithubWatchSource` (repo from roster or --repo override)
   *   - `WatcherStore` (dir from --state-dir or `<xdg>/watch-cursors/`)
   *   - `runOneTick` (dedup + predicate + persist)
   *   - Sink → stdout event line + stderr failure line + heartbeat file
   */
  private async runWatch(args: readonly string[], selfName: string, roster: Roster, ctx: Context): Promise<number> {
    const opts = this.parseWatchArgs(args, ctx);
    if (opts === undefined) return 1;

    // Resolve the repo — CLI arg wins, else roster.githubRepo, else error.
    const repo = opts.repo ?? roster.githubRepo;
    if (repo === undefined || repo === "") {
      ctx.stderr.write(`❌ team watch: no GitHub repo configured.\n`);
      ctx.stderr.write(`   Add 'github_repo: owner/name' to .dridock/agents.yml, or pass --repo owner/name.\n`);
      return 1;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      ctx.stderr.write(`❌ team watch: invalid repo '${repo}' — expected owner/name.\n`);
      return 1;
    }

    // Resolve state dir. Container: `<xdg>/watch-cursors/` (per-project
    // by construction — the container's XDG is bind-mounted from
    // <xdg>/projects/<id>/claude/). Host (Arfy on Mac): `<xdg>/watch-cursors/`
    // (machine-wide). Same code, different meaning by runtime.
    const stateDir = opts.stateDir ?? `${await xdgRoot(ctx.fs, ctx.env.raw(), ctx.home)}/watch-cursors`;

    const runner = this.deps.host ?? new RealHostCommandRunner();
    const source = new GithubWatchSource(runner, repo);
    const store = new WatcherStore(ctx.fs, stateDir, "github");
    const heartbeatPath = `${stateDir}/github.heartbeat`;

    const sink: WatcherSink = {
      onEvent: (event) => {
        // stdout — one line per surfaced event. `tail -f`-friendly.
        const time = event.observedAt.slice(11, 19); // HH:MM:SS
        const sender = event.header?.sender ?? "<legacy>";
        // Strip the header prefix from the summary so the display line
        // doesn't repeat "Arfy->Bear: verified — Arfy: verified".
        const summary = stripHeaderFromSummary(event.summary);
        ctx.stdout.write(`[${time}] ${event.ref} ← ${sender}: ${summary}\n`);
      },
      onPollFailed: (source, reason) => {
        // stderr — user-visible warning without polluting the event stream.
        ctx.stderr.write(`⚠️  team watch: ${source} poll failed: ${reason}\n`);
      },
      onTickComplete: async (summary) => {
        // Heartbeat file — the liveness signal a session-start hook reads
        // to detect a silently-dead watcher. Best-effort; if writing
        // fails we don't crash the loop.
        try {
          await ctx.fs.writeText(heartbeatPath, JSON.stringify({
            ...summary,
            atIso: new Date().toISOString(),
            self: selfName,
            repo,
          }));
        } catch { /* best-effort */ }
        if (process.env["DEBUG"] === "true") {
          ctx.stderr.write(`  tick: ${summary.kind}, seen=${summary.seen}, surfaced=${summary.surfaced}, ${summary.elapsedMs}ms\n`);
        }
      },
    };

    // Surface config so the user sees what's running.
    ctx.stderr.write(`👀 team watch: self=${selfName}, repo=${repo}, interval=${opts.intervalMs}ms${opts.once ? " (once)" : ""}\n`);

    // Single-tick mode (SessionStart catch-up).
    if (opts.once) {
      await runOneTick({ source, store, sink, selfName });
      return 0;
    }

    // Live loop. SIGINT/SIGTERM → save state (already done per-tick) + exit clean.
    const stopSignal = { stopped: false };
    const handleStop = (): void => {
      if (stopSignal.stopped) return;
      stopSignal.stopped = true;
      ctx.stderr.write(`\n👋 team watch: stopping (state persisted).\n`);
    };
    const sleeper = this.deps.sleep ?? defaultSleep;
    process.once("SIGINT", handleStop);
    process.once("SIGTERM", handleStop);
    try {
      while (!stopSignal.stopped) {
        await runOneTick({ source, store, sink, selfName });
        if (stopSignal.stopped) break;
        await sleeper(opts.intervalMs);
      }
    } finally {
      process.removeListener("SIGINT", handleStop);
      process.removeListener("SIGTERM", handleStop);
    }
    return 0;
  }

  private parseWatchArgs(args: readonly string[], ctx: Context): WatchOpts | undefined {
    const opts: WatchOpts = { once: false, intervalMs: DEFAULT_POLL_INTERVAL_MS };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--once") { opts.once = true; continue; }
      if (a === "--repo" && args[i + 1] !== undefined) { opts.repo = args[i + 1]; i++; continue; }
      if (a?.startsWith("--repo=")) { opts.repo = a.slice("--repo=".length); continue; }
      if (a === "--interval" && args[i + 1] !== undefined) {
        const n = Number(args[i + 1]);
        if (!Number.isFinite(n) || n < 1000) {
          ctx.stderr.write(`❌ team watch: --interval must be a number >= 1000 (ms), got '${args[i + 1]}'\n`);
          return undefined;
        }
        opts.intervalMs = n;
        i++;
        continue;
      }
      if (a === "--state-dir" && args[i + 1] !== undefined) { opts.stateDir = args[i + 1]; i++; continue; }
      ctx.stderr.write(`❌ team watch: unexpected argument '${a}' (allowed: --once, --repo <owner/name>, --interval <ms>, --state-dir <path>)\n`);
      return undefined;
    }
    // Env var overrides — DRIDOCK_WATCH_POLL_INTERVAL_MS is the flag that
    // matches the rest of the DRIDOCK_* env convention.
    const envInterval = process.env["DRIDOCK_WATCH_POLL_INTERVAL_MS"];
    if (envInterval !== undefined && envInterval !== "") {
      const n = Number(envInterval);
      if (Number.isFinite(n) && n >= 1000) opts.intervalMs = n;
    }
    return opts;
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
    ctx.stderr.write(`  watch [--once]        poll GitHub for messages addressed to self; surface\n`);
    ctx.stderr.write(`                        via stdout. --once = one catchup tick then exit\n`);
    ctx.stderr.write(`                        (SessionStart hook). --repo owner/name overrides\n`);
    ctx.stderr.write(`                        the roster's github_repo. Ctrl-C persists state\n`);
    ctx.stderr.write(`                        and exits cleanly.\n`);
  }
}

export interface TeamCommandDeps {
  readonly git: GitToplevel;
  readonly host: HostCommandRunner;
  /** Injected in tests to skip real 30s sleeps between poll ticks. */
  readonly sleep: (ms: number) => Promise<void>;
}

interface WatchOpts {
  once: boolean;
  intervalMs: number;
  repo?: string;
  stateDir?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** If the summary opens with the same "Sender[->Recipient]:" prefix
 *  that already appears in the display line, strip it so the output
 *  isn't "[15:04:32] #42 ← Arfy: Arfy: hello". Keeps rendering tight. */
function stripHeaderFromSummary(summary: string): string {
  // Reuses the header shape from AgentTeamHeader — only strips the
  // canonical `Sender:` or `Sender->A,B:` opener plus one trailing space.
  return summary.replace(/^\s*\*{0,2}[A-Za-z][\w-]*(?:->[A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*)?:\*{0,2}\s*/, "");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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

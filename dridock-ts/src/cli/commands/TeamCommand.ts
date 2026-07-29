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
import { makeInboxSink, inboxPathFor, pidfileFor, logfileFor } from "../../services/InboxSink.ts";
import { isPidAlive, RealProcessProbe, type ProcessProbe } from "../../services/PidLiveness.ts";
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
    if (sub !== "whoami" && sub !== "roster" && sub !== "post" && sub !== "watch" && sub !== "fetcher") {
      ctx.stderr.write(`❌ team: unknown subcommand '${sub}' (allowed: whoami, roster, post, watch, fetcher)\n`);
      return 1;
    }

    // Centralized --help intercept for subverbs (spec #59 part 1). A
    // `<verb> --help` request is metadata about the command — it must
    // not require a project dir OR a roster to be resolvable. Any
    // subverb call with -h/--help in its args prints the subverb's
    // full usage and returns 0 BEFORE the roster load below runs. This
    // is the fix for the misleading "unexpected argument '--help'"
    // error Arfy hit on team post; every subverb gets it in one place.
    if (args.slice(1).some((a) => a === "-h" || a === "--help")) {
      this.printSubverbUsage(sub, ctx);
      return 0;
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
    if (sub === "fetcher") return await this.runFetcher(args.slice(1), resolved.selfName, ctx);
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

    // TTY-detect hint (spec #59 part 3): when stdout is a terminal —
    // i.e. nothing is piping the composed message into `gh issue
    // comment` — the operator very likely thinks they just SENT the
    // message. They didn't; `team post` is compose-only. Print one
    // stderr line so the mistake is caught at the exact moment it's
    // made, not later when someone points out the message never
    // arrived. Same failure shape as #56's silent-degrade class.
    const isTTY = this.deps.stdoutIsTTY?.() ?? (process.stdout.isTTY === true);
    if (isTTY) {
      ctx.stderr.write(`⚠ team post is COMPOSE-ONLY — nothing was sent.\n`);
      ctx.stderr.write(`  Pipe the output into gh(1) to actually post, e.g.:\n`);
      ctx.stderr.write(`    ... | ${ctx.binName} team post --to Arfy | gh issue comment <n> --repo owner/name --body-file -\n`);
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

    // Resolve state dir. Both host + container use `<xdg>/watch-cursors/`,
    // where `<xdg>` = `$XDG_CONFIG_HOME/dridock` (falls back to
    // `~/.config/dridock` if unset). Host: XDG_CONFIG_HOME is unset by
    // default → `~/.config/dridock/watch-cursors/`, machine-wide. Container
    // (post-#58): entrypoint.sh sets XDG_CONFIG_HOME to
    // `/home/claude/.claude/xdg-config` — a subdir of the bind-mounted
    // `~/.claude/` — so state PERSISTS across container recreates. Same
    // code path both sides; the container's environment does the redirect.
    const stateDir = opts.stateDir ?? `${await xdgRoot(ctx.fs, ctx.env.raw(), ctx.home)}/watch-cursors`;

    const runner = this.deps.host ?? new RealHostCommandRunner();
    const source = new GithubWatchSource(runner, repo);
    const store = new WatcherStore(ctx.fs, stateDir, "github");
    const heartbeatPath = `${stateDir}/github.heartbeat`;

    // Sink selection: `--inbox` = fetcher mode (JSONL append to per-agent
    // file, spawned detached by SessionStart hook, spec #56); default =
    // stdout display line (--once for SessionStart catchup, or a human
    // running the loop in a terminal). Both keep the heartbeat + poll-
    // failed semantics identical so the SessionStart nag still fires.
    const sink: WatcherSink = opts.inbox !== undefined
      ? makeInboxSink({
          fs: ctx.fs,
          inboxPath: opts.inbox,
          selfName,
          repo,
          heartbeatPath,
          stderr: ctx.stderr,
        })
      : this.makeStdoutSink(ctx, heartbeatPath, selfName, repo);

    // Fetcher mode (--inbox + LIVE loop, not --once): write pidfile so
    // `dridock team fetcher status/stop` can find us, and remove it on
    // clean shutdown. Pidfile format is one line with just the PID —
    // cheapest possible parse. Written BEFORE the first tick so an
    // immediate crash still leaves a pidfile the liveness check can
    // detect+diagnose (stale pid → kill -0 fails → hook reports "died at
    // boot, see log"). --once mode skips the pidfile: it exits quickly
    // and isn't the durable background process fetcher-status watches for.
    if (opts.inbox !== undefined && !opts.once) {
      try {
        await ctx.fs.mkdirRecursive(opts.inbox.substring(0, opts.inbox.lastIndexOf("/")));
        await ctx.fs.writeText(pidfileFor(opts.inbox), `${process.pid}\n`);
      } catch (e) {
        ctx.stderr.write(`⚠️  team watch: failed to write pidfile ${pidfileFor(opts.inbox)}: ${e instanceof Error ? e.message : String(e)}\n`);
        // Continue anyway — the fetcher can still run without a pidfile;
        // status/stop verbs just won't find it. Loud, not fatal.
      }
    }

    // Surface config so the user sees what's running.
    ctx.stderr.write(`👀 team watch: self=${selfName}, repo=${repo}, interval=${opts.intervalMs}ms${opts.once ? " (once)" : ""}${opts.inbox !== undefined ? `, inbox=${opts.inbox}` : ""}\n`);

    // FRESH-START warning (Arfy's #56 mitigation, landed with #58): if the
    // persisted cursor is empty, this is the first spawn (post-install or
    // post-state-loss). `GithubWatchSource.poll("")` maps to `nowIso()` so
    // historical events are NOT replayed. Make that loud on stderr —
    // otherwise the log looks identical to a clean resume, and any events
    // posted before this timestamp are gone with no signal. Only bother in
    // --inbox (fetcher) mode: a `--once` SessionStart catch-up has its own
    // "no cursors file yet" note printed from the hook.
    if (opts.inbox !== undefined && !opts.once) {
      const initialState = await store.load();
      if (initialState.cursor === "") {
        ctx.stderr.write(`⚠️  team watch: FRESH START — no prior cursor at ${stateDir}.\n`);
        ctx.stderr.write(`    Historical events posted before this spawn will NOT be delivered.\n`);
        ctx.stderr.write(`    Persistence begins now; subsequent restarts pick up where this run left off.\n`);
      }
    }

    // Single-tick mode (SessionStart catch-up).
    if (opts.once) {
      await runOneTick({ source, store, sink, selfName });
      return 0;
    }

    // Live loop. SIGINT/SIGTERM → save state (already done per-tick) +
    // remove pidfile (fetcher mode) + exit clean.
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
      if (opts.inbox !== undefined) {
        try { await ctx.fs.removeFile(pidfileFor(opts.inbox)); } catch { /* best-effort */ }
      }
    }
    return 0;
  }

  /** Default stdout sink — display-line format, one line per event.
   *  Used when `--inbox` is NOT set (SessionStart catch-up via --once,
   *  or a human running the loop in a terminal). */
  private makeStdoutSink(
    ctx: Context,
    heartbeatPath: string,
    selfName: string,
    repo: string,
  ): WatcherSink {
    return {
      onEvent: (event) => {
        const time = event.observedAt.slice(11, 19); // HH:MM:SS
        const sender = event.header?.sender ?? "<legacy>";
        // Strip the header prefix from the summary so the display line
        // doesn't repeat "Arfy->Bear: verified — Arfy: verified".
        const summary = stripHeaderFromSummary(event.summary);
        ctx.stdout.write(`[${time}] ${event.ref} ← ${sender}: ${summary}\n`);
      },
      onPollFailed: (source, reason) => {
        ctx.stderr.write(`⚠️  team watch: ${source} poll failed: ${reason}\n`);
      },
      onTickComplete: async (summary: WatcherTickSummary) => {
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
  }

  /**
   * `dridock team fetcher <status|stop|log>` — lifecycle inspection +
   * control for the `--inbox` mode's detached background fetcher (spec
   * #56, `docs/design/agent-teams-delivery.md`).
   *
   * Default inbox path is convention-based (`<xdg>/dridock/inbox/<agent>.jsonl`);
   * override with `--inbox <path>`. status returns rc=0 if a fetcher is
   * running, rc=1 if pidfile exists but process is dead (stale), rc=2 if
   * no pidfile at all. stop = SIGTERM + pidfile cleanup. log = tail the
   * stderr log next to the inbox.
   */
  private async runFetcher(args: readonly string[], selfName: string, ctx: Context): Promise<number> {
    const sub = args[0];
    if (sub === undefined || sub === "" || sub === "-h" || sub === "--help") {
      ctx.stderr.write(`usage: ${ctx.binName} team fetcher <status|stop|log> [--inbox <path>] [--lines N]\n`);
      ctx.stderr.write(`  Inspect + control the detached team-watch fetcher spawned by the SessionStart hook.\n`);
      return sub === "-h" || sub === "--help" ? 0 : 1;
    }
    if (sub !== "status" && sub !== "stop" && sub !== "log") {
      ctx.stderr.write(`❌ team fetcher: unknown subcommand '${sub}' (allowed: status, stop, log)\n`);
      return 1;
    }

    // Parse --inbox override + --lines (log only). Everything else = error.
    let inbox: string | undefined;
    let lines = 40;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--inbox" && args[i + 1] !== undefined) { inbox = args[i + 1]; i++; continue; }
      if (a?.startsWith("--inbox=")) { inbox = a.slice("--inbox=".length); continue; }
      if (a === "--lines" && args[i + 1] !== undefined) {
        const n = Number(args[i + 1]);
        if (!Number.isFinite(n) || n < 1) {
          ctx.stderr.write(`❌ team fetcher: --lines must be a positive number, got '${args[i + 1]}'\n`);
          return 1;
        }
        lines = n;
        i++;
        continue;
      }
      ctx.stderr.write(`❌ team fetcher: unexpected argument '${a}'\n`);
      return 1;
    }

    // Convention default: <xdg-dridock>/inbox/<selfName>.jsonl.
    const inboxPath = inbox ?? inboxPathFor(await xdgRoot(ctx.fs, ctx.env.raw(), ctx.home), selfName);
    const pidPath = pidfileFor(inboxPath);
    const logPath = logfileFor(inboxPath);

    if (sub === "status") return await this.runFetcherStatus(inboxPath, pidPath, logPath, ctx);
    if (sub === "stop")   return await this.runFetcherStop(inboxPath, pidPath, ctx);
    return await this.runFetcherLog(logPath, lines, ctx);
  }

  private async runFetcherStatus(inboxPath: string, pidPath: string, logPath: string, ctx: Context): Promise<number> {
    const pidText = await ctx.fs.readTextOrUndefined(pidPath);
    if (pidText === undefined) {
      ctx.stdout.write(`fetcher: not running (no pidfile at ${pidPath})\n`);
      ctx.stdout.write(`  inbox: ${inboxPath}\n`);
      ctx.stdout.write(`  log:   ${logPath}\n`);
      return 2;
    }
    const pid = Number(pidText.trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      ctx.stdout.write(`fetcher: pidfile at ${pidPath} is malformed (${pidText.trim()})\n`);
      return 1;
    }
    const alive = isPidAlive(pid, inboxPath, this.deps.probe ?? new RealProcessProbe());
    ctx.stdout.write(`fetcher: ${alive ? "alive" : "DEAD (stale pidfile — pid not alive OR cmdline mismatch)"} (pid=${pid})\n`);
    ctx.stdout.write(`  inbox: ${inboxPath}\n`);
    ctx.stdout.write(`  log:   ${logPath}\n`);
    // Last stderr line for a quick health cue — trivial when dead.
    const logText = await ctx.fs.readTextOrUndefined(logPath);
    if (logText !== undefined && logText.trim() !== "") {
      const lastLine = logText.trimEnd().split("\n").at(-1) ?? "";
      ctx.stdout.write(`  last log line: ${lastLine}\n`);
    }
    return alive ? 0 : 1;
  }

  private async runFetcherStop(inboxPath: string, pidPath: string, ctx: Context): Promise<number> {
    const pidText = await ctx.fs.readTextOrUndefined(pidPath);
    if (pidText === undefined) {
      ctx.stderr.write(`team fetcher stop: no pidfile at ${pidPath} — nothing to stop.\n`);
      return 2;
    }
    const pid = Number(pidText.trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      ctx.stderr.write(`team fetcher stop: pidfile at ${pidPath} is malformed (${pidText.trim()}) — removing it.\n`);
      try { await ctx.fs.removeFile(pidPath); } catch { /* best-effort */ }
      return 1;
    }
    // Cmdline verify BEFORE sending SIGTERM — spec #56 open loop #4.
    // If the recorded pid is alive but doesn't match our fetcher (pid
    // wraparound / reboot), SIGTERM'ing it would kill an unrelated
    // process. Treat mismatch as stale pidfile, not a live fetcher.
    if (!isPidAlive(pid, inboxPath, this.deps.probe ?? new RealProcessProbe())) {
      ctx.stderr.write(`team fetcher stop: pid ${pid} is not our fetcher (dead or cmdline mismatch); removing stale pidfile.\n`);
      try { await ctx.fs.removeFile(pidPath); } catch { /* best-effort */ }
      return 0;
    }
    // SIGTERM lets the fetcher's own SIGTERM handler flush state +
    // remove the pidfile. If it's already dead, kill() throws ESRCH; treat
    // as success (goal achieved) and clean up the stale pidfile ourselves.
    try {
      process.kill(pid, "SIGTERM");
      ctx.stdout.write(`team fetcher stop: sent SIGTERM to pid ${pid} (inbox=${inboxPath}).\n`);
      return 0;
    } catch (e) {
      // ESRCH means the process is already gone. Anything else is a real
      // failure (permission, etc.) — surface it.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ESRCH") || msg.includes("no such process")) {
        ctx.stderr.write(`team fetcher stop: pid ${pid} is already gone; removing stale pidfile.\n`);
        try { await ctx.fs.removeFile(pidPath); } catch { /* best-effort */ }
        return 0;
      }
      ctx.stderr.write(`team fetcher stop: failed to signal pid ${pid}: ${msg}\n`);
      return 1;
    }
  }

  private async runFetcherLog(logPath: string, lines: number, ctx: Context): Promise<number> {
    const text = await ctx.fs.readTextOrUndefined(logPath);
    if (text === undefined) {
      ctx.stderr.write(`team fetcher log: no log file at ${logPath}\n`);
      return 2;
    }
    const all = text.split("\n");
    // Preserve original line ordering; slice last N. Trim trailing empty
    // line from split so output isn't a stray blank at end.
    const tail = all.slice(-lines - 1).filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
    ctx.stdout.write(`${tail.join("\n")}\n`);
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
      if (a === "--inbox" && args[i + 1] !== undefined) { opts.inbox = args[i + 1]; i++; continue; }
      if (a?.startsWith("--inbox=")) { opts.inbox = a.slice("--inbox=".length); continue; }
      ctx.stderr.write(`❌ team watch: unexpected argument '${a}' (allowed: --once, --repo <owner/name>, --interval <ms>, --state-dir <path>, --inbox <path>)\n`);
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

  /** Print the specific subverb's full usage text. Called by the
   *  centralized --help intercept in run() so `team <sub> --help`
   *  reaches HERE instead of the subverb's arg parser. */
  private printSubverbUsage(sub: string, ctx: Context): void {
    const bin = ctx.binName;
    switch (sub) {
      case "whoami":
        ctx.stdout.write(`usage: ${bin} team whoami\n`);
        ctx.stdout.write(`  Print THIS runtime's agent name (from DRIDOCK_AGENT_NAME env, or the\n`);
        ctx.stdout.write(`  single-agent roster fallback if the roster has exactly one agent).\n`);
        ctx.stdout.write(`  Prints the name on stdout (pipe-clean: SELF=$(dridock team whoami)) and a\n`);
        ctx.stdout.write(`  short "(from X)" diagnostic on stderr.\n`);
        return;
      case "roster":
        ctx.stdout.write(`usage: ${bin} team roster\n`);
        ctx.stdout.write(`  Print the whole team from .dridock/agents.yml — agents (name, role,\n`);
        ctx.stdout.write(`  environment) plus the human. Read-only; roster edits go through\n`);
        ctx.stdout.write(`  bootstrap or a hand-edit.\n`);
        return;
      case "post":
        ctx.stdout.write(`usage: ${bin} team post [--to A,B]\n`);
        ctx.stdout.write(`  COMPOSE-ONLY: prepend the "Sender[->A,B]:" header to stdin and write\n`);
        ctx.stdout.write(`  the result to stdout. Broadcast when --to is omitted. Does NOT hit the\n`);
        ctx.stdout.write(`  network — pipe into gh(1) to actually post:\n`);
        ctx.stdout.write(`\n`);
        ctx.stdout.write(`      echo "hi" | ${bin} team post --to Arfy | \\\n`);
        ctx.stdout.write(`          gh issue comment 46 --repo owner/name --body-file -\n`);
        ctx.stdout.write(`\n`);
        ctx.stdout.write(`  Recipient names must be in the roster (agents + human); typos are\n`);
        ctx.stdout.write(`  rejected before composing.\n`);
        return;
      case "watch":
        ctx.stdout.write(`usage: ${bin} team watch [--once] [--repo owner/name] [--interval <ms>]\n`);
        ctx.stdout.write(`                        [--state-dir <path>] [--inbox <path>]\n`);
        ctx.stdout.write(`  Poll GitHub for messages addressed to self; surface each survived event.\n`);
        ctx.stdout.write(`  Default sink is stdout (one line per event, tail-friendly). --inbox\n`);
        ctx.stdout.write(`  switches to JSONL append into a per-agent inbox file (fetcher mode,\n`);
        ctx.stdout.write(`  spawned detached by the SessionStart hook — spec #56).\n`);
        ctx.stdout.write(`\n`);
        ctx.stdout.write(`  --once           one catchup tick then exit (SessionStart hook).\n`);
        ctx.stdout.write(`  --repo <r>       override roster's github_repo.\n`);
        ctx.stdout.write(`  --interval <ms>  poll interval (default 30000, min 1000).\n`);
        ctx.stdout.write(`  --state-dir <p>  cursor + dedup ring state dir (default <xdg>/watch-cursors).\n`);
        ctx.stdout.write(`  --inbox <p>      append JSONL events to <p> instead of stdout (fetcher mode).\n`);
        ctx.stdout.write(`                   Pidfile at <p>.pid, log at <p>.log, session cursors at\n`);
        ctx.stdout.write(`                   <p>.session-cursors.json.\n`);
        ctx.stdout.write(`\n`);
        ctx.stdout.write(`  Env: DRIDOCK_WATCH_POLL_INTERVAL_MS overrides --interval.\n`);
        ctx.stdout.write(`  Ctrl-C persists state and exits cleanly.\n`);
        return;
      case "fetcher":
        ctx.stdout.write(`usage: ${bin} team fetcher <status|stop|log> [--inbox <path>] [--lines N]\n`);
        ctx.stdout.write(`  Inspect + control the detached team-watch fetcher spawned by the\n`);
        ctx.stdout.write(`  SessionStart hook (spec #56).\n`);
        ctx.stdout.write(`\n`);
        ctx.stdout.write(`  status  print pid + alive/dead + inbox + log + last stderr line.\n`);
        ctx.stdout.write(`          rc=0 alive, rc=1 dead-or-cmdline-mismatch, rc=2 no pidfile.\n`);
        ctx.stdout.write(`  stop    cmdline-verify then SIGTERM the pid, remove pidfile.\n`);
        ctx.stdout.write(`  log     tail of stderr log (default 40 lines; --lines N to override).\n`);
        ctx.stdout.write(`\n`);
        ctx.stdout.write(`  --inbox <p>  override the convention-default inbox path\n`);
        ctx.stdout.write(`               (<xdg>/dridock/inbox/<agent>.jsonl).\n`);
        return;
      default:
        // Should be unreachable — subverb allowlist gates run() before this.
        this.printUsage(ctx);
    }
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
    ctx.stderr.write(`                        --inbox <path> = fetcher mode: append JSONL to\n`);
    ctx.stderr.write(`                        per-agent inbox file instead of stdout (spec #56).\n`);
    ctx.stderr.write(`                        Spawned detached by SessionStart hook; pidfile at\n`);
    ctx.stderr.write(`                        <path>.pid, stderr log at <path>.log.\n`);
    ctx.stderr.write(`  fetcher <sub>         inspect/control the --inbox fetcher lifecycle:\n`);
    ctx.stderr.write(`                        status | stop | log [--lines N] [--inbox <path>]\n`);
  }
}

export interface TeamCommandDeps {
  readonly git: GitToplevel;
  readonly host: HostCommandRunner;
  /** Injected in tests to skip real 30s sleeps between poll ticks. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Injected in tests for `dridock team fetcher status|stop` — the
   *  cmdline-verifying pid-liveness probe (spec #56 open loop #4).
   *  Prod default is [[RealProcessProbe]] (spawns `ps -p <pid>`). */
  readonly probe: ProcessProbe;
  /** Injected in tests to force `dridock team post`'s TTY-detect
   *  branch on/off deterministically. Prod default reads
   *  `process.stdout.isTTY`. Spec: #59 part 3 — a compose-only run
   *  with no consumer prints an actionable hint on stderr so the user
   *  knows the message wasn't actually sent. */
  readonly stdoutIsTTY: () => boolean;
}

interface WatchOpts {
  once: boolean;
  intervalMs: number;
  repo?: string;
  stateDir?: string;
  /** When set, switch from stdout display sink to append-JSONL fetcher
   *  sink writing to this per-agent inbox file. Spawned detached by
   *  the SessionStart hook (spec: #56). */
  inbox?: string;
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

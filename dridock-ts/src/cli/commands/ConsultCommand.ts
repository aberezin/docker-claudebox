import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { ConsultStore } from "../../services/ConsultStore.ts";
import { stateHome } from "../../domain/paths.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Clock } from "../../infra/Clock.ts";
import { RealClock } from "../../infra/Clock.ts";

/**
 * `dridock consult <verb>` — supervised claudebot ↔ framework-Claude
 * threads. Ports the consult) case at wrapper.sh:2463.
 *
 * All subverbs shipped in P4c:
 *   list           — enabled + one-line per thread
 *   show <id>      — meta + turns + optional proposed.diff
 *   approve <id>   — status → awaiting-claudebot + human turn
 *   revise <id>    — status → awaiting-framework + human turn (optional note)
 *   reject <id>    — status → rejected + human turn (optional reason)
 *   post <id> …    — low-level append (author + status + diff optional)
 *   watch          — poll until a thread enters awaiting-framework
 */
export class ConsultCommand implements Command {
  readonly verb = "consult" as const;

  constructor(
    private readonly clockOverride?: Clock,
    /** Sleep-and-poll injection — tests override to avoid real wall-clock. */
    private readonly sleepFn: (ms: number) => Promise<void> = defaultSleep,
    /** Max poll iterations before watch exits without a match (test hook — real value uses 0 = unlimited). */
    private readonly maxWatchIterations = 0,
    /** Stdin reader — tests override to inject body content. */
    private readonly readStdin: () => Promise<string> = defaultReadStdin,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "list";
    const home = await stateHome(ctx.fs, process.env, ctx.home, "consult");
    const store = new ConsultStore(ctx.fs, home, this.clockOverride ?? new RealClock());

    switch (sub) {
      case "list": return await this.list(store, home, ctx);
      case "show": return await this.show(store, args[1], ctx);
      case "approve": return await this.approve(store, args[1], ctx);
      case "revise": return await this.revise(store, args[1], args.slice(2), ctx);
      case "reject": return await this.reject(store, args[1], args.slice(2), ctx);
      case "post": return await this.post(store, args.slice(1), ctx, this.readStdin);
      case "watch": return await this.watch(store, home, args.slice(1), ctx);
      case "-h": case "--help":
        ctx.stdout.write(`usage: ${ctx.binName} consult list|show|approve|revise|reject|post|watch <id>\n`);
        return 0;
      default:
        throw new DridockError(`consult: unknown subcommand '${sub}' (allowed: list, show, approve, revise, reject, post, watch)`);
    }
  }

  private async list(store: ConsultStore, home: string, ctx: Context): Promise<number> {
    const threads = await store.list();
    if (threads.length === 0) {
      ctx.stdout.write(`no consults in ${home}\n`);
      return 0;
    }
    const idWidth = threads.reduce((w, t) => Math.max(w, t.id.length), 0);
    ctx.stdout.write(`consults (${threads.length}) in ${home}:\n`);
    for (const t of threads) {
      const status = t.status !== "" ? t.status : "?";
      const title = t.title !== "" ? t.title : "(no title)";
      ctx.stdout.write(`  ${t.id.padEnd(idWidth)}  [${status}]  ${title}\n`);
    }
    ctx.stdout.write(`\nshow:  ${ctx.binName} consult show <id>     approve/revise/reject: ${ctx.binName} consult <verb> <id>\n`);
    return 0;
  }

  private async show(store: ConsultStore, id: string | undefined, ctx: Context): Promise<number> {
    if (id === undefined || id === "") {
      ctx.stderr.write(`usage: ${ctx.binName} consult show <id>\n`);
      return 1;
    }
    const rec = await store.show(id);
    if (rec === undefined) {
      ctx.stderr.write(`no such consult: ${id}\n`);
      return 1;
    }
    ctx.stdout.write(`=== consult ${id} ===\n`);
    if (rec.meta !== "") ctx.stdout.write(rec.meta);
    ctx.stdout.write(`\n`);
    for (const turn of rec.turns) {
      ctx.stdout.write(`── ${turn.name} ──\n${turn.body}\n`);
    }
    if (rec.diff !== undefined) {
      ctx.stdout.write(`── proposed.diff ──\n${rec.diff}`);
    }
    return 0;
  }

  private async approve(store: ConsultStore, id: string | undefined, ctx: Context): Promise<number> {
    if (id === undefined || id === "") {
      ctx.stderr.write(`usage: ${ctx.binName} consult approve <id>\n`);
      return 1;
    }
    if (!(await this.threadExists(store, id, ctx))) return 1;
    const status = (await store.meta(id)).get("status") ?? "";
    if (status !== "awaiting-approval") {
      ctx.stderr.write(`note: status is '${status}' (expected awaiting-approval)\n`);
    }
    await store.setMeta(id, "status", "awaiting-claudebot");
    await store.post(id, "human", `Approved by the human. Framework-Claude: apply the proposed change, commit, and post the reply with the commit hash.\n`);
    ctx.stdout.write(`✅ approved ${id} — framework-Claude will now apply + reply.\n`);
    return 0;
  }

  private async revise(store: ConsultStore, id: string | undefined, rest: readonly string[], ctx: Context): Promise<number> {
    if (id === undefined || id === "") {
      ctx.stderr.write(`usage: ${ctx.binName} consult revise <id> [note]\n`);
      return 1;
    }
    if (!(await this.threadExists(store, id, ctx))) return 1;
    await store.setMeta(id, "status", "awaiting-framework");
    const note = rest.length > 0 ? rest.join(" ") : "please revise the draft";
    await store.post(id, "human", note + "\n");
    ctx.stdout.write(`↩️  bounced ${id} back for revision.\n`);
    return 0;
  }

  private async reject(store: ConsultStore, id: string | undefined, rest: readonly string[], ctx: Context): Promise<number> {
    if (id === undefined || id === "") {
      ctx.stderr.write(`usage: ${ctx.binName} consult reject <id> [reason]\n`);
      return 1;
    }
    if (!(await this.threadExists(store, id, ctx))) return 1;
    await store.setMeta(id, "status", "rejected");
    const note = rest.length > 0 ? rest.join(" ") : "rejected";
    await store.post(id, "human", note + "\n");
    ctx.stdout.write(`🚫 rejected ${id}.\n`);
    return 0;
  }

  /**
   * post <id> [--author A] [--status S] [--diff F] < body
   * Ports wrapper.sh:2506. Body arrives on stdin (injectable for tests).
   */
  private async post(store: ConsultStore, args: readonly string[], ctx: Context, readStdin: () => Promise<string>): Promise<number> {
    const id = args[0];
    if (id === undefined || id === "") {
      ctx.stderr.write(`usage: ${ctx.binName} consult post <id> [--author A] [--status S] [--diff F] < body\n`);
      return 1;
    }
    let author = "framework";
    let status: string | undefined;
    let diffPath: string | undefined;
    let i = 1;
    while (i < args.length) {
      const a = args[i];
      const next = args[++i];
      switch (a) {
        case "--author": author = next ?? "framework"; break;
        case "--status": status = next; break;
        case "--diff": diffPath = next; break;
        default:
          // #37 Tier 1 #6 audit rule: reject unknown post flags loudly.
          throw new DridockError(`consult post: unknown arg '${a}' (allowed: --author, --status, --diff)`);
      }
      i++;
    }
    const body = await readStdin();
    await store.post(id, author, body);
    if (diffPath !== undefined && diffPath !== "") {
      // #37 Tier 1 #6 (cont.) — require the file to exist + copy to succeed
      await store.attachDiff(id, diffPath);
    }
    if (status !== undefined && status !== "") {
      await store.setMeta(id, "status", status);
    }
    ctx.stdout.write(`posted ${author} turn to ${id}${status !== undefined ? ` (status=${status})` : ""}\n`);
    return 0;
  }

  /**
   * `watch [interval]` — poll consult sig for threads entering
   * awaiting-framework and print them. Blocks until match OR
   * maxWatchIterations exceeded (0 = unlimited). Never wakes on
   * awaiting-approval / awaiting-claudebot (framework-Claude sets those
   * itself; would self-trigger).
   */
  private async watch(store: ConsultStore, home: string, args: readonly string[], ctx: Context): Promise<number> {
    const intervalArg = args[0];
    const intervalSec = intervalArg !== undefined && /^\d+$/.test(intervalArg) ? parseInt(intervalArg, 10) : 20;
    const act = async (): Promise<Set<string>> => {
      const sig = await store.sig();
      const out = new Set<string>();
      for (const line of sig) {
        const [id, status, _turns] = line.split("|");
        if (status === "awaiting-framework" && id !== undefined) out.add(`${id}|${_turns ?? "0"}`);
      }
      return out;
    };
    let base = await act();
    ctx.stderr.write(`👁  watching ${home} for consults needing a framework draft (every ${intervalSec}s; Ctrl-C to stop)…\n`);
    let iter = 0;
    while (true) {
      if (this.maxWatchIterations > 0 && iter >= this.maxWatchIterations) return 0;
      iter++;
      await this.sleepFn(intervalSec * 1000);
      const cur = await act();
      const fresh = [...cur].filter((e) => !base.has(e));
      if (fresh.length > 0) {
        ctx.stdout.write(`🗣  consult(s) awaiting a framework draft:\n`);
        for (const e of fresh) {
          const [id] = e.split("|");
          ctx.stdout.write(`  ${id}   (${ctx.binName} consult show ${id})\n`);
        }
        return 0;
      }
      base = cur;
    }
  }

  private async threadExists(store: ConsultStore, id: string, ctx: Context): Promise<boolean> {
    if (await ctx.fs.isDirectory(store.threadDir(id))) return true;
    ctx.stderr.write(`no such consult: ${id}\n`);
    return false;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultReadStdin(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch { return ""; }
}

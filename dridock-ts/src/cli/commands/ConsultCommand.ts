import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { ConsultStore } from "../../services/ConsultStore.ts";
import { stateHome } from "../../domain/paths.ts";
import { DridockError } from "../../domain/errors.ts";

/**
 * `dridock consult <verb>` — supervised claudebot ↔ framework-Claude thread
 * management. Ports the corresponding bash `consult)` case at wrapper.sh:2463.
 *
 * Phase 2 only implements the READ verbs (`list`, `show`) since they're
 * FileSystem-only. The mutating verbs (approve / revise / reject / post /
 * watch) land in Phase 3 alongside the migrators — they need to write meta
 * files and the sidecar-write layer isn't in yet.
 */
export class ConsultCommand implements Command {
  readonly verb = "consult" as const;

  async run(args: string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "list";
    // Match bash: bare `dridock consult` (no sub) defaults to `list`.
    if (sub === "list") return await this.list(ctx);

    // Unported sub-verbs go through the phased-port fallback so the bash
    // wrapper can still handle them today. Phase 3+ lands them here.
    if (["show", "approve", "revise", "reject", "post", "watch"].includes(sub)) {
      ctx.stderr.write(`dridock-ts (Phase 2): '${ctx.binName} consult ${sub}' not yet ported — use the bash wrapper\n`);
      return 2;
    }
    throw new DridockError(`consult: unknown subcommand '${sub}' (allowed: list, show, approve, revise, reject, post, watch)`);
  }

  private async list(ctx: Context): Promise<number> {
    const home = await stateHome(ctx.fs, process.env, ctx.home, "consult");
    const store = new ConsultStore(ctx.fs, home);
    const threads = await store.list();

    if (threads.length === 0) {
      ctx.stdout.write(`no consults in ${home}\n`);
      return 0;
    }

    // Pad ids to the widest id in the batch so the `[status]` column
    // aligns across rows of different id widths. Bash uses printf
    // widths for this. Arfy #38 part 3 caught the earlier tight
    // rendering as differing from bash for mixed-width id sets
    // (single-width batch looks identical; ≥2 widths reveal the diff).
    const idWidth = threads.reduce((w, t) => Math.max(w, t.id.length), 0);
    ctx.stdout.write(`consults (${threads.length}) in ${home}:\n`);
    for (const t of threads) {
      const status = t.status !== "" ? t.status : "?";
      const title = t.title !== "" ? t.title : "(no title)";
      // wrapper.sh:2474 shape: `  %s  [%s]  %s`, id right-padded to
      // max width for column alignment.
      ctx.stdout.write(`  ${t.id.padEnd(idWidth)}  [${status}]  ${title}\n`);
    }
    ctx.stdout.write(`\nshow:  ${ctx.binName} consult show <id>     approve/revise/reject: ${ctx.binName} consult <verb> <id>\n`);
    return 0;
  }
}

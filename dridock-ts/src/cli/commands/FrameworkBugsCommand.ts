import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { stateHome } from "../../domain/paths.ts";

/**
 * `dridock framework-bugs [list|clear]` — review + prune cross-project
 * framework bug reports. Ports wrapper.sh's framework-bugs case + related
 * helpers. Reports are markdown files written by cb-report-bug from inside
 * the container; they land in `<xdg>/framework-bugs/`.
 */
export class FrameworkBugsCommand implements Command {
  readonly verb = "framework-bugs" as const;

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "list";
    if (sub === "list") return await this.list(ctx);
    if (sub === "clear") return await this.clear(ctx);
    if (sub === "-h" || sub === "--help") {
      ctx.stdout.write(`usage: ${ctx.binName} framework-bugs [list|clear]\n`);
      return 0;
    }
    throw new DridockError(`framework-bugs: unknown sub-verb '${sub}' (allowed: list, clear)`);
  }

  private async list(ctx: Context): Promise<number> {
    const home = await stateHome(ctx.fs, process.env, ctx.home, "framework-bugs");
    if (!(await ctx.fs.isDirectory(home))) {
      ctx.stdout.write(`no framework bug reports (${home} doesn't exist)\n`);
      return 0;
    }
    const entries = await ctx.fs.listDir(home);
    const mds = entries.filter((n) => n.endsWith(".md")).sort();
    if (mds.length === 0) {
      ctx.stdout.write(`no framework bug reports in ${home}\n`);
      return 0;
    }
    ctx.stdout.write(`framework bugs (${mds.length}) in ${home}:\n`);
    for (const name of mds) {
      // First line of each report is `# Title` — surface it for quick scan.
      const text = await ctx.fs.readTextOrUndefined(`${home}/${name}`);
      const title = text?.split("\n").find((l) => l.startsWith("# "))?.replace(/^#\s*/, "") ?? "(no title)";
      ctx.stdout.write(`  ${name}   ${title}\n`);
    }
    ctx.stdout.write(`\nread with: cat ${home}/<name>.md   clear: ${ctx.binName} framework-bugs clear\n`);
    return 0;
  }

  private async clear(ctx: Context): Promise<number> {
    const home = await stateHome(ctx.fs, process.env, ctx.home, "framework-bugs");
    if (!(await ctx.fs.isDirectory(home))) return 0;
    const entries = await ctx.fs.listDir(home);
    let n = 0;
    for (const name of entries) {
      if (name.endsWith(".md")) {
        await ctx.fs.removeFile(`${home}/${name}`);
        n++;
      }
    }
    ctx.stdout.write(`cleared ${n} framework bug report(s) in ${home}\n`);
    return 0;
  }
}

import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Clock } from "../../infra/Clock.ts";
import { RealClock } from "../../infra/Clock.ts";
import { stateHome } from "../../domain/paths.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock report-bug <title>` — file a framework bug report from the
 * host side. Same drop dir as the container-side `cb-report-bug`
 * (`<xdg>/framework-bugs/<project-id>-<ts>-<slug>.md`). Ports the
 * host-side path for the same class the container reports on.
 *
 * Body arrives on stdin (bash heredoc pattern):
 *   dridock report-bug "title" << 'EOF'
 *   ## What I was doing
 *   ...
 *   EOF
 */
export class ReportBugCommand implements Command {
  readonly verb = "report-bug" as const;

  constructor(
    private readonly clockOverride?: Clock,
    private readonly gitOverride?: GitToplevel,
    private readonly readStdin: () => Promise<string> = defaultReadStdin,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    let title = "";
    let layer = "other";
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === "--layer") {
        layer = args[++i] ?? "other";
      } else if (a === "-h" || a === "--help") {
        ctx.stdout.write(`usage: ${ctx.binName} report-bug "<title>" [--layer wrapper|entrypoint|image|networking|other] < body-on-stdin\n`);
        return 0;
      } else if (title === "") {
        title = a ?? "";
      } else {
        throw new DridockError(`report-bug: extra positional after title: '${a}'`);
      }
      i++;
    }
    if (title === "") {
      ctx.stderr.write(`usage: ${ctx.binName} report-bug "<title>" [--layer <layer>] < body-on-stdin\n`);
      return 1;
    }
    const body = await this.readStdin();
    const clock = this.clockOverride ?? new RealClock();
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectId = (await new ProjectConfig(ctx.fs).projectId(project.configPath)) ?? "unknown-project";
    const ts = clock.timestamp();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const filename = `${projectId}-${ts}-${slug}.md`;
    const home = await stateHome(ctx.fs, process.env, ctx.home, "framework-bugs");
    await ctx.fs.mkdirRecursive(home);
    const content = `# ${title}\n\n**Layer:** ${layer}\n**Project:** ${projectId}\n**Timestamp:** ${ts}\n\n${body}\n`;
    await ctx.fs.writeText(`${home}/${filename}`, content, { mode: 0o644 });
    ctx.stdout.write(`filed: ${home}/${filename}\n`);
    return 0;
  }
}

async function defaultReadStdin(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch { return ""; }
}

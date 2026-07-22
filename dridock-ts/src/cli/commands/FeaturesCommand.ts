import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock features <verb>` — the 3.0 rename of `profiles`. Ports the
 * corresponding bash `features)` case at wrapper.sh:2323 + `cb_features_cmd`
 * at wrapper.sh:1430.
 *
 * Phase 2 only implements `list` (or bare `dridock features`, which defaults
 * to list). The "enabled" half is FileSystem-only; the "available" catalog
 * needs a Docker throwaway container against the project image — that piece
 * is stubbed with a Phase 3 marker.
 *
 * enable/disable/info stubbed with rc=2 + "use bash wrapper" — those mutate
 * config.yml (need the safe-rewrite scaffolding due in Phase 3) or need
 * Docker access (info runs a `cat manifest.yml` in a throwaway container).
 */
export class FeaturesCommand implements Command {
  readonly verb: "features" | "profiles";

  constructor(
    verb: "features" | "profiles" = "features",
    private readonly gitOverride?: GitToplevel,
  ) {
    this.verb = verb;
  }

  async run(args: string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "list";

    // Legacy `profiles` alias — one-line deprecation notice to stderr, same
    // as bash's cb_profiles_cmd, then fall through to features handling.
    if (this.verb === "profiles") {
      ctx.stderr.write(`ℹ 'dridock profiles' is a legacy alias — use 'dridock features' (removed in 4.0).\n`);
    }

    if (sub === "list" || sub === "") return await this.list(ctx);
    if (sub === "-h" || sub === "--help") { this.printHelp(ctx); return 0; }

    if (["enable", "disable", "info"].includes(sub)) {
      ctx.stderr.write(`dridock-ts (Phase 2): '${ctx.binName} features ${sub}' not yet ported — use the bash wrapper\n`);
      return 2;
    }
    throw new DridockError(`features: unknown sub-verb '${sub}' (try: ${ctx.binName} features --help)`);
  }

  private async list(ctx: Context): Promise<number> {
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const cfg = new ProjectConfig(ctx.fs);
    const enabled = await cfg.features(project.configPath);

    ctx.stdout.write(`enabled for this project (${project.dotName}/config.yml → features:):\n`);
    if (enabled.length > 0) {
      for (const f of enabled) ctx.stdout.write(`  ${f}\n`);
    } else {
      ctx.stdout.write(`  (none — add e.g.  features: [typescript, python]  to ${project.dotName}/config.yml, or run '${ctx.binName} features enable typescript')\n`);
    }
    ctx.stdout.write(`\n`);
    // Available-features listing needs Docker — Phase 3.
    ctx.stdout.write(`available: (Phase 2 stub — 'available' listing needs Docker, use bash wrapper for the full list)\n`);
    ctx.stdout.write(`\n`);
    ctx.stdout.write(`enable / disable: '${ctx.binName} features enable <name>' / '${ctx.binName} features disable <name>'\n`);
    return 0;
  }

  private printHelp(ctx: Context): void {
    ctx.stdout.write(`usage: ${ctx.binName} features [list | enable <name> | disable <name> | info <name>]\n`);
    ctx.stdout.write(`  list                    show enabled + available features (default)\n`);
    ctx.stdout.write(`  enable <name>           add <name> to features: in .dridock/config.yml\n`);
    ctx.stdout.write(`  disable <name>          remove <name> from features: (runs the feature's off.sh)\n`);
    ctx.stdout.write(`  info <name>             print the feature's manifest.yml\n`);
    ctx.stdout.write(`\n`);
    ctx.stdout.write(`  '${ctx.binName} profiles' is an alias for one deprecation cycle (2.x → 3.0).\n`);
    ctx.stdout.write(`  Full design: docs/design/features-system.md\n`);
  }
}

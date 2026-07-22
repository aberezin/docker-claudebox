import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock features <verb>` — the 3.0 rename of `profiles`. Ports the
 * corresponding bash `features)` case + cb_features_cmd at wrapper.sh:1430.
 *
 * Phase 2 shipped `list` (FS-only). Phase 3 adds `enable`/`disable`/`info`:
 *   enable/disable go through ProjectConfig.setFeatures → writeTextAtomic,
 *   so a crash mid-write can never leave a truncated config.yml (the
 *   3.3.6 Tier-1 #5 class of bug — silent-write-failure).
 *   info is stubbed for Phase 4 — needs to `docker run --rm cat
 *   /usr/local/lib/dridock/features/<name>/manifest.yml`.
 */
const FEATURE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

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

    if (this.verb === "profiles") {
      ctx.stderr.write(`ℹ 'dridock profiles' is a legacy alias — use 'dridock features' (removed in 4.0).\n`);
    }

    if (sub === "list" || sub === "") return await this.list(ctx);
    if (sub === "-h" || sub === "--help") { this.printHelp(ctx); return 0; }
    if (sub === "enable") return await this.enable(args[1], ctx);
    if (sub === "disable") return await this.disable(args[1], ctx);
    if (sub === "info") {
      ctx.stderr.write(`dridock-ts (Phase 3): '${ctx.binName} features info' not yet ported — use the bash wrapper (needs Docker cat on image)\n`);
      return 2;
    }
    throw new DridockError(`features: unknown sub-verb '${sub}' (try: ${ctx.binName} features --help)`);
  }

  private async list(ctx: Context): Promise<number> {
    const project = await this.resolveProject(ctx);
    const cfg = new ProjectConfig(ctx.fs);
    const enabled = await cfg.features(project.configPath);

    ctx.stdout.write(`enabled for this project (${project.dotName}/config.yml → features:):\n`);
    if (enabled.length > 0) {
      for (const f of enabled) ctx.stdout.write(`  ${f}\n`);
    } else {
      ctx.stdout.write(`  (none — add e.g.  features: [typescript, python]  to ${project.dotName}/config.yml, or run '${ctx.binName} features enable typescript')\n`);
    }
    ctx.stdout.write(`\n`);
    ctx.stdout.write(`available: (Phase 4 — 'available' listing needs Docker, use bash wrapper for the full list)\n\n`);
    ctx.stdout.write(`enable / disable: '${ctx.binName} features enable <name>' / '${ctx.binName} features disable <name>'\n`);
    return 0;
  }

  private async enable(name: string | undefined, ctx: Context): Promise<number> {
    if (name === undefined || name === "") {
      ctx.stderr.write(`usage: ${ctx.binName} features enable <name>\n`);
      return 1;
    }
    if (!FEATURE_NAME_REGEX.test(name)) {
      ctx.stderr.write(`features enable: bad name '${name}' (allowed: A-Z a-z 0-9 _ -)\n`);
      return 1;
    }
    const project = await this.resolveProject(ctx);
    const cfg = new ProjectConfig(ctx.fs);
    const existing = await cfg.features(project.configPath);
    if (existing.includes(name)) {
      ctx.stdout.write(`  ✓ ${name} already enabled\n`);
      return 0;
    }
    const next = [...existing, name];
    await cfg.setFeatures(project.configPath, next);
    ctx.stdout.write(`  ✓ enabled feature '${name}' (${next.join(", ")}). On next '${ctx.binName}' run, on.sh installs it.\n`);
    return 0;
  }

  private async disable(name: string | undefined, ctx: Context): Promise<number> {
    if (name === undefined || name === "") {
      ctx.stderr.write(`usage: ${ctx.binName} features disable <name>\n`);
      return 1;
    }
    if (!FEATURE_NAME_REGEX.test(name)) {
      ctx.stderr.write(`features disable: bad name '${name}' (allowed: A-Z a-z 0-9 _ -)\n`);
      return 1;
    }
    const project = await this.resolveProject(ctx);
    const cfg = new ProjectConfig(ctx.fs);
    const existing = await cfg.features(project.configPath);
    if (!existing.includes(name)) {
      ctx.stdout.write(`  ℹ ${name} isn't in features: — nothing to disable\n`);
      return 0;
    }
    const remaining = existing.filter((f) => f !== name);
    await cfg.setFeatures(project.configPath, remaining);
    const remainingHint = remaining.length > 0 ? ` (remaining: ${remaining.join(", ")})` : "";
    // Phase 4 will run off.sh in the container if it's up + remove the
    // ~/.claude/.feature-<name> marker in the project's data dir.
    ctx.stdout.write(`  ✓ disabled feature '${name}'${remainingHint}. off.sh will run on next '${ctx.binName}' start.\n`);
    return 0;
  }

  private async resolveProject(ctx: Context) {
    const git = this.gitOverride ?? new RealGitToplevel();
    return await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
  }

  private printHelp(ctx: Context): void {
    ctx.stdout.write(`usage: ${ctx.binName} features [list | enable <name> | disable <name> | info <name>]\n`);
    ctx.stdout.write(`  list                    show enabled + available features (default)\n`);
    ctx.stdout.write(`  enable <name>           add <name> to features: in .dridock/config.yml\n`);
    ctx.stdout.write(`  disable <name>          remove <name> from features: (runs the feature's off.sh)\n`);
    ctx.stdout.write(`  info <name>             print the feature's manifest.yml\n\n`);
    ctx.stdout.write(`  '${ctx.binName} profiles' is an alias for one deprecation cycle (2.x → 3.0).\n`);
    ctx.stdout.write(`  Full design: docs/design/features-system.md\n`);
  }
}

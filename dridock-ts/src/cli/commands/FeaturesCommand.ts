import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext } from "../../infra/Docker.ts";

/**
 * `dridock features <verb>` — the 3.0 rename of `profiles`. Ports the
 * corresponding bash `features)` case + cb_features_cmd at wrapper.sh:1430.
 *
 * P4c completes the surface:
 *   list — enabled (FS) + available (Docker cat on cb-infra image)
 *   enable / disable — safe-rewrite via ProjectConfig.setFeatures
 *   info <name> — Docker cat on the feature's manifest.yml
 */
const FEATURE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export class FeaturesCommand implements Command {
  readonly verb: "features" | "profiles";

  constructor(
    verb: "features" | "profiles" = "features",
    private readonly gitOverride?: GitToplevel,
    private readonly dockerOverride?: Docker,
    private readonly imageName = "dridock:latest",
  ) {
    this.verb = verb;
  }

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "list";

    if (this.verb === "profiles") {
      ctx.stderr.write(`ℹ 'dridock profiles' is a legacy alias — use 'dridock features' (removed in 4.0).\n`);
    }

    if (sub === "list" || sub === "") return await this.list(ctx);
    if (sub === "-h" || sub === "--help") { this.printHelp(ctx); return 0; }
    if (sub === "enable") return await this.enable(args[1], ctx);
    if (sub === "disable") return await this.disable(args[1], ctx);
    if (sub === "info") return await this.info(args[1], ctx);
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

    // Available — Docker cat on cb-infra's baked feature manifests
    // (matches wrapper.sh:1320-1322 shell one-liner). Empty output when
    // cb-infra is down / image absent — surfaced as "(cb-infra
    // unavailable)" per audit rule.
    const docker = this.dockerOverride ?? new RealDocker();
    const shellScript = [
      'for d in /usr/local/lib/dridock/features/*/; do',
      '  [ -d "$d" ] || continue;',
      '  n="$(basename "$d")";',
      '  dsc="$(awk -F: \'/^description:/{sub(/^[^:]*:[[:space:]]*/,"" ); print; exit}\' "$d/manifest.yml" 2>/dev/null)";',
      '  printf "%s\\t%s\\n" "$n" "${dsc:-—}";',
      'done',
      'for f in /usr/local/lib/dridock/profiles/*.sh /usr/local/lib/claudebox/profiles/*.sh; do',
      '  [ -f "$f" ] || continue;',
      '  printf "%s\\t(legacy 2.x profile) %s\\n" "$(basename "$f" .sh)" "$(sed -n "s/^# summary: //p" "$f" | head -1)";',
      'done',
    ].join(" ");
    const captured = await docker.runCapture(infraContext(), this.imageName, {
      entrypoint: "sh", args: ["-c", shellScript],
    });
    if (captured.rc !== 0 || captured.stdout.trim() === "") {
      ctx.stdout.write(`available: (cb-infra unavailable or image absent — run '${ctx.binName} checkversion' to diagnose)\n\n`);
    } else {
      ctx.stdout.write(`available (baked in the image):\n`);
      const rows: Array<[string, string]> = [];
      for (const line of captured.stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (t === "") continue;
        const [name, description] = t.split("\t", 2) as [string, string];
        rows.push([name, description ?? "—"]);
      }
      // Sort + dedupe by name (bash pipes through `sort -u -k1,1`)
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      const seen = new Set<string>();
      for (const [name, description] of rows) {
        if (seen.has(name)) continue;
        seen.add(name);
        ctx.stdout.write(`  ${name.padEnd(14)} ${description}\n`);
      }
      ctx.stdout.write(`\n`);
    }
    ctx.stdout.write(`enable / disable: '${ctx.binName} features enable <name>' / '${ctx.binName} features disable <name>'\n`);
    return 0;
  }

  private async info(name: string | undefined, ctx: Context): Promise<number> {
    if (name === undefined || name === "") {
      ctx.stderr.write(`usage: ${ctx.binName} features info <name>\n`);
      return 1;
    }
    if (!FEATURE_NAME_REGEX.test(name)) {
      ctx.stderr.write(`features info: bad name '${name}' (allowed: A-Z a-z 0-9 _ -)\n`);
      return 1;
    }
    const docker = this.dockerOverride ?? new RealDocker();
    // Ports wrapper.sh:1338 — check `/usr/local/lib/dridock/features/<name>/`
    // for manifest.yml + on.sh + off.sh + bake.sh; fall back to legacy
    // `/usr/local/lib/dridock/profiles/<name>.sh` (2.x); else "unknown".
    const shellScript = [
      `d=/usr/local/lib/dridock/features/${name};`,
      `if [ -f "$d/manifest.yml" ]; then`,
      `  echo '--- manifest.yml ---';`,
      `  cat "$d/manifest.yml";`,
      `  for s in on.sh off.sh bake.sh; do`,
      `    [ -f "$d/$s" ] && echo "--- $s ---" && head -20 "$d/$s";`,
      `  done;`,
      `else`,
      `  legacy=/usr/local/lib/dridock/profiles/${name}.sh;`,
      `  if [ -f "$legacy" ]; then`,
      `    echo '(legacy 2.x profile — has no manifest)';`,
      `    head -20 "$legacy";`,
      `  else`,
      `    echo "features info: unknown feature '${name}'" >&2;`,
      `    exit 1;`,
      `  fi;`,
      `fi`,
    ].join(" ");
    const captured = await docker.runCapture(infraContext(), this.imageName, {
      entrypoint: "sh", args: ["-c", shellScript],
    });
    if (captured.stdout !== "") ctx.stdout.write(captured.stdout);
    if (captured.rc !== 0) {
      ctx.stderr.write(`features info: unknown feature '${name}' or cb-infra image absent\n`);
      return 1;
    }
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

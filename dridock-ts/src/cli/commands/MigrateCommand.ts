import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { WorkspaceMigrator } from "../../services/migrators/WorkspaceMigrator.ts";
import { DataDirMigrator } from "../../services/migrators/DataDirMigrator.ts";
import { MachineConfigMigrator } from "../../services/migrators/MachineConfigMigrator.ts";
import { StateDirsMigrator } from "../../services/migrators/StateDirsMigrator.ts";
import { accumulateRc, isSkip, type MigrationReport } from "../../services/MigrationReport.ts";
import { configHome } from "../../domain/paths.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { ProcessProbe } from "../../infra/ProcessProbe.ts";
import { RealProcessProbe } from "../../infra/ProcessProbe.ts";
import type { Clock } from "../../infra/Clock.ts";
import { RealClock } from "../../infra/Clock.ts";

/**
 * `dridock migrate [--all]` — 3.0-era migration of `.claudebox/`-shape state
 * to `.dridock/`. Ports the corresponding bash case at wrapper.sh:2333 +
 * cb_migrate_workspace/_data_dir/_machine_config/_state_dirs.
 *
 * The audit rule (visible warning + non-zero rc on any silent-skip)
 * is enforced structurally by MigrationReport.kind: the renderer routes
 * `applied` / `merged` to stdout and `skipped-conflict` /
 * `merged-with-collisions` to stderr, and accumulateRc() sums to exit 1
 * whenever ANY of the migrators surfaced a conflict.
 *
 * The bug in 3.3.2 (`exit 0` hardcoded despite the ⚠ line) is impossible
 * here — the exit code is derived from the same reports that fed the
 * output, one call from accumulateRc.
 */
export class MigrateCommand implements Command {
  readonly verb = "migrate" as const;

  constructor(
    private readonly gitOverride?: GitToplevel,
    private readonly probeOverride?: ProcessProbe,
    private readonly clockOverride?: Clock,
  ) {}

  async run(args: string[], ctx: Context): Promise<number> {
    let all = false;
    for (const arg of args) {
      switch (arg) {
        case "--all": all = true; break;
        case "-h": case "--help":
          this.printHelp(ctx); return 0;
        default:
          throw new DridockError(`migrate: unknown arg '${arg}' (try --help)`);
      }
    }

    const git = this.gitOverride ?? new RealGitToplevel();
    const probe = this.probeOverride ?? new RealProcessProbe();
    const clock = this.clockOverride ?? new RealClock();
    const resolver = new ProjectRootResolver(ctx.fs, git);
    const initialProject = await resolver.resolve(ctx.cwd);
    const xdgBase = configHome(process.env, ctx.home);

    ctx.stdout.write(`migrate: ${initialProject.root}\n`);

    const reports: MigrationReport[] = [];
    // Run the four migrators sequentially — order matches wrapper.sh:2366-2370
    // so anyone reading the output sees the same "workspace, data dir, machine,
    // state" sequence as the bash version.
    reports.push(...(await new WorkspaceMigrator(ctx.fs, initialProject.root).migrate()));

    // Re-resolve project state AFTER the workspace migrator has run — if it
    // moved .claudebox/config.yml to .dridock/config.yml, we want to read
    // the id from the NEW location. Bash gets this for free because
    // cb_project_id_ro re-runs cb_project_dot every call.
    const postWorkspaceProject = await resolver.resolve(ctx.cwd);
    const projectId = await new ProjectConfig(ctx.fs).projectId(postWorkspaceProject.configPath);
    if (projectId !== undefined) {
      reports.push(...(await new DataDirMigrator(ctx.fs, xdgBase, projectId).migrate()));
    }
    reports.push(...(await new MachineConfigMigrator(ctx.fs, xdgBase).migrate()));
    reports.push(...(await new StateDirsMigrator(ctx.fs, probe, clock, xdgBase).migrate()));

    if (all) {
      // --all sweep of every legacy project data dir under
      // <xdg>/claudebox/projects/. Workspace paths are unknown to the
      // wrapper — those migrate on their next auto-migrate.
      ctx.stdout.write(`migrate --all: sweeping legacy project data dirs...\n`);
      const legacyProjectsRoot = `${xdgBase}/claudebox/projects`;
      if (await ctx.fs.isDirectory(legacyProjectsRoot)) {
        const ids = await ctx.fs.listDir(legacyProjectsRoot);
        for (const id of ids) {
          if (id === projectId) continue; // already handled above
          const isDir = await ctx.fs.isDirectory(`${legacyProjectsRoot}/${id}`);
          if (!isDir) continue;
          reports.push(...(await new DataDirMigrator(ctx.fs, xdgBase, id).migrate()));
        }
        // Try to remove the now-empty legacy projects/ root
        await ctx.fs.rmDirIfEmpty(legacyProjectsRoot);
        await ctx.fs.rmDirIfEmpty(`${xdgBase}/claudebox`);
      } else {
        ctx.stdout.write(`  (no legacy claudebox/projects/ dir — nothing to sweep)\n`);
      }
    }

    this.renderReports(reports, ctx);
    const rc = accumulateRc(reports);
    if (rc !== 0) {
      ctx.stdout.write(`⚠  done — but one or more state dirs were skipped (see warnings above). Resolve and re-run '${ctx.binName} migrate'.\n`);
    } else {
      ctx.stdout.write(`✅ done.\n`);
    }
    return rc;
  }

  private renderReports(reports: readonly MigrationReport[], ctx: Context): void {
    for (const r of reports) {
      switch (r.outcome.kind) {
        case "nothing-to-do":
          // Silent — matches bash's `[ -f ... ] || return 0` branches.
          break;
        case "applied":
          ctx.stdout.write(`  ✓ ${r.item}: ${prettyPath(r.outcome.from)} → ${prettyPath(r.outcome.to)}`);
          if (r.outcome.note !== undefined) ctx.stdout.write(`  (${r.outcome.note})`);
          ctx.stdout.write(`\n`);
          break;
        case "merged": {
          const collided = r.outcome.collisionCount ?? 0;
          if (collided > 0) {
            ctx.stderr.write(`  ⚠ ${r.item}: SPLIT-BRAIN merged — ${r.outcome.cleanCount} clean, ${collided} collision(s) kept side-by-side (suffix ${r.outcome.collidedSuffix}).\n`);
          } else {
            ctx.stdout.write(`  ✓ ${r.item}: ${prettyPath(r.outcome.from)} → ${prettyPath(r.outcome.to)}  (merged ${r.outcome.cleanCount} entries into existing dridock/)\n`);
          }
          break;
        }
        case "skipped-conflict":
          ctx.stderr.write(`  ⚠ ${r.item}: ${r.outcome.reason}\n`);
          for (const hint of r.outcome.hints) ctx.stderr.write(`     ${hint}\n`);
          break;
      }
    }
    // Sanity: the accumulator must match what we just rendered — a
    // guard against renderer/rc-accumulator drift (the exact class the
    // 3.3.1/3.3.2 followups fixed for state_dirs only).
    const anySkip = reports.some((r) => isSkip(r.outcome));
    const skipRc = accumulateRc(reports);
    if (anySkip !== (skipRc !== 0)) {
      throw new DridockError(`migrate: internal — renderer/accumulator disagreement (anySkip=${anySkip}, rc=${skipRc})`, 99);
    }
  }

  private printHelp(ctx: Context): void {
    ctx.stdout.write(`usage: ${ctx.binName} migrate [--all]\n`);
    ctx.stdout.write(`  migrate this project's .claudebox/ → .dridock/ (workspace + its data dir),\n`);
    ctx.stdout.write(`  plus the machine config (~/.config/claudebox/config.yml) and the four\n`);
    ctx.stdout.write(`  cross-project state dirs (cdp, consult, framework-bugs, host-agent).\n`);
    ctx.stdout.write(`  --all also migrates every legacy project data dir under\n`);
    ctx.stdout.write(`        ~/.config/claudebox/projects/ (workspace paths are unknown to the\n`);
    ctx.stdout.write(`        wrapper — those migrate on their next '${ctx.binName}' auto-migrate).\n`);
  }
}

function prettyPath(p: string): string {
  const home = process.env["HOME"];
  return home !== undefined && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

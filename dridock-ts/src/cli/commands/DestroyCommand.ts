import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import { projectProfile } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock destroy [--purge]` — destroy this project's VM. Ports
 * wrapper.sh:2402. `--purge` also deletes the per-project data dir
 * (session/settings/plugins/sidecars) for a truly clean slate.
 */
export class DestroyCommand implements Command {
  readonly verb = "destroy" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly gitOverride?: GitToplevel,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    let purge = false;
    for (const arg of args) {
      switch (arg) {
        case "--purge": case "--purge-data": purge = true; break;
        case "-h": case "--help":
          ctx.stdout.write(`usage: ${ctx.binName} destroy [--purge]   (--purge also deletes this project's session/data dir)\n`);
          return 0;
        default:
          throw new DridockError(`destroy: unknown arg '${arg}' (try --help)`);
      }
    }

    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stdout.write(`no dridock project here (.dridock/config.yml missing)\n`);
      return 0;
    }
    const colima = this.colimaOverride ?? new RealColima();
    const profile = projectProfile(id);
    ctx.stdout.write(`  💥 destroying VM ${profile}...\n`);
    await colima.delete(profile);
    ctx.stdout.write(`  ✓ ${profile} destroyed\n`);

    if (purge) {
      const dataDir = await new MachineConfig(ctx.fs, process.env, ctx.home).projectDataDir(id);
      // Guard: the resolved path must contain the project id — protects
      // against a machine config typo somehow yielding e.g. `/` or `$HOME`.
      // Matches the same class as bash's cb_purge_data guard at :813.
      if (!dataDir.includes(`/${id}/`)) {
        ctx.stderr.write(`❌ refusing to rm -rf ${dataDir} — path doesn't contain project id '${id}' (config error?)\n`);
        return 1;
      }
      ctx.stdout.write(`  🧹 purging data dir ${dataDir}...\n`);
      await ctx.fs.removeDirRecursive(dataDir);
      ctx.stdout.write(`  ✓ purged\n`);
    }
    return 0;
  }
}

import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import { projectProfile } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock destroy [--purge]` — destroy this project's VM. Ports
 * wrapper.sh:2402. `--purge` also deletes the project's data dir
 * (session/settings/plugins) — deferred to bash for now since it needs
 * the `cb_project_data_dir` machine-config lookup + a big rm -rf.
 * The VM-destroy half runs entirely here.
 */
export class DestroyCommand implements Command {
  readonly verb = "destroy" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly gitOverride?: GitToplevel,
  ) {}

  async run(args: string[], ctx: Context): Promise<number> {
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
      ctx.stderr.write(`dridock-ts (Phase 4): --purge (data-dir rm -rf) not yet ported — use the bash wrapper for --purge\n`);
      return 2;
    }
    return 0;
  }
}

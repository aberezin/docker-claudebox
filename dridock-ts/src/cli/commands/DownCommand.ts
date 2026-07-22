import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import { projectProfile } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock down` — stop THIS project's VM. Ports the corresponding case at
 * wrapper.sh:2397. Idempotent: if the project has no config.yml, print
 * "no dridock VM for this project" and exit 0 (matches bash's `[ -z ...
 * ] && exit 0`). If the VM is already stopped, `colima stop` is still
 * called (it's a no-op) — cheap way to guarantee post-condition.
 */
export class DownCommand implements Command {
  readonly verb = "down" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly gitOverride?: GitToplevel,
  ) {}

  async run(_args: string[], ctx: Context): Promise<number> {
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stdout.write(`no dridock VM for this project (no .dridock/config.yml or legacy .claudebox/config.yml)\n`);
      return 0;
    }
    const colima = this.colimaOverride ?? new RealColima();
    const profile = projectProfile(id);
    ctx.stdout.write(`  ↓ stopping VM ${profile}...\n`);
    await colima.stop(profile);
    ctx.stdout.write(`  ✓ ${profile} stopped\n`);
    return 0;
  }
}

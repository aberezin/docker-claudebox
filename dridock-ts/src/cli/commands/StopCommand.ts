import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { ContainerRuntime } from "../../infra/ContainerRuntime.ts";
import { RealContainerRuntime } from "../../infra/ContainerRuntime.ts";
import { projectContext, projectProfile } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { containerName } from "../../services/ContainerName.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock stop` — kill the interactive claudebot container for $PWD but
 * leave the VM up. Ports wrapper.sh:3023-3035. Never boots the VM: if the
 * VM is stopped, there's nothing to kill by definition.
 */
export class StopCommand implements Command {
  readonly verb = "stop" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly runtimeOverride?: ContainerRuntime,
    private readonly gitOverride?: GitToplevel,
  ) {}

  async run(_args: string[], ctx: Context): Promise<number> {
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stdout.write(`no dridock project here (nothing to stop)\n`);
      return 0;
    }
    const colima = this.colimaOverride ?? new RealColima();
    const runtime = this.runtimeOverride ?? new RealContainerRuntime();
    const profile = projectProfile(id);
    const context = projectContext(id);
    const cname = containerName(ctx.cwd);

    if (!(await colima.isRunning(profile))) {
      ctx.stdout.write(`nothing running (VM ${profile} not up)\n`);
      return 0;
    }

    const row = await runtime.psFilter(context, cname);
    if (row === undefined) {
      ctx.stdout.write(`nothing running (no container ${cname})\n`);
      return 0;
    }

    await runtime.stop(context, cname);
    ctx.stdout.write(`stopped ${cname}\n`);
    return 0;
  }
}

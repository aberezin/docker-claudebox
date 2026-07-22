import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext, projectContext, projectProfile } from "../../infra/Docker.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";

/**
 * `dridock info` — human-facing at-a-glance for the current project. Ports
 * cb_info at wrapper.sh:1164. Also serves as `dridock status` (alias).
 *
 * Phase 2 coverage: versions (via Docker interface), workspace + project
 * paths (via FileSystem), secrets.env presence + key count. VM status,
 * container status, and network IP need a Colima adapter that lands in
 * Phase 3 — those rows print a marked "(Phase 3)" placeholder so the
 * output shape is stable and users see exactly what's not yet ported.
 */
export class InfoCommand implements Command {
  readonly verb: "info" | "status";

  constructor(
    verb: "info" | "status" = "info",
    private readonly imageName = "dridock:latest",
    private readonly dockerOverride?: Docker,
    private readonly gitOverride?: GitToplevel,
  ) {
    this.verb = verb;
  }

  async run(_args: string[], ctx: Context): Promise<number> {
    const docker = this.dockerOverride ?? new RealDocker();
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectId = await new ProjectConfig(ctx.fs).projectId(project.configPath);

    ctx.stdout.write(`dridock — info\n\n`);

    // ── versions ────────────────────────────────────────────────────────
    ctx.stdout.write(`versions:\n`);
    ctx.stdout.write(`  wrapper (host):    ${DRIDOCK_TS_VERSION}   (${ctx.binName}-ts)\n`);
    ctx.stdout.write(`  image (cb-infra):  ${await docker.imageVersion(infraContext(), this.imageName)}\n`);
    if (projectId !== undefined) {
      ctx.stdout.write(`  image (project):   ${await docker.imageVersion(projectContext(projectId), this.imageName)}\n`);
    }
    ctx.stdout.write(`\n`);

    // ── project ─────────────────────────────────────────────────────────
    ctx.stdout.write(`project:\n`);
    ctx.stdout.write(`  workspace:         ${project.root}\n`);
    if (projectId === undefined) {
      ctx.stdout.write(`  (not a dridock project yet — run '${ctx.binName} start' here to initialize)\n\n`);
    } else {
      ctx.stdout.write(`  project id:        ${projectId}\n`);
      ctx.stdout.write(`  VM:                ${projectProfile(projectId)}   (VM status: Phase 3 stub — needs Colima adapter, use bash wrapper)\n`);
      ctx.stdout.write(`  config.yml:        ${project.configPath}\n`);
      await this.renderSecretsRow(project.dotDir, ctx);
      ctx.stdout.write(`  data dir:          <XDG data dir>/${projectId}/claude   (session/settings/plugins — Phase 3 will resolve the path)\n`);
      ctx.stdout.write(`  container:         (container status: Phase 3 stub — needs Docker ps adapter, use bash wrapper)\n`);
      ctx.stdout.write(`\n`);
      ctx.stdout.write(`network:             (Phase 3 stub — needs Colima adapter for VM IP; use bash wrapper for the network block)\n`);
      ctx.stdout.write(`\n`);
    }

    // ── machine ─────────────────────────────────────────────────────────
    ctx.stdout.write(`machine:             (Phase 3 stub — needs Colima adapter for cb-infra VM status)\n`);
    return 0;
  }

  private async renderSecretsRow(dotDir: string, ctx: Context): Promise<void> {
    const secretsPath = `${dotDir}/secrets.env`;
    const text = await ctx.fs.readTextOrUndefined(secretsPath);
    if (text === undefined) {
      ctx.stdout.write(`  secrets.env:       (none — add ${dotDir}/secrets.env, chmod 600)\n`);
      return;
    }
    let keys = 0;
    for (const line of text.split(/\r?\n/)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) keys++;
    }
    ctx.stdout.write(`  secrets.env:       ${secretsPath}   (${keys} key(s))\n`);
  }
}

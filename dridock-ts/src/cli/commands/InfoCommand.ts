import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext, projectContext, projectProfile } from "../../infra/Docker.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig, parseTopLevelString } from "../../services/ProjectConfig.ts";
import { xdgRoot } from "../../domain/paths.ts";
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
      // Bash-parity: baked claude CLI version — separate axis from the
      // harness semver. Matches wrapper.sh:1092. Arfy #38 §🟠 caught the
      // sibling row missing in checkversion; adding here for consistency.
      ctx.stdout.write(`  claude CLI (image): ${await docker.imageClaudeCliVersion(projectContext(projectId), this.imageName)}\n`);
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
      // Resolve data-dir path via machine config → baked default. Bash:
      //   cb_data_root = cb_expand_path(cb_machine_get(data_root))
      //   baked default: <xdg>/projects
      //   project_data_dir(id) = <data_root>/<id>/claude
      // Arfy #38 §🟠 caught the literal `<XDG data dir>` token in output.
      const dataDir = await this.resolveDataDir(ctx, projectId);
      ctx.stdout.write(`  data dir:          ${dataDir}   (session/settings/plugins)\n`);
      ctx.stdout.write(`  container:         (container status: Phase 3 stub — needs Docker ps adapter, use bash wrapper)\n`);
      ctx.stdout.write(`\n`);
      ctx.stdout.write(`network:             (Phase 3 stub — needs Colima adapter for VM IP; use bash wrapper for the network block)\n`);
      ctx.stdout.write(`\n`);
    }

    // ── machine ─────────────────────────────────────────────────────────
    ctx.stdout.write(`machine:             (Phase 3 stub — needs Colima adapter for cb-infra VM status)\n`);
    return 0;
  }

  /**
   * Resolve the project's data-dir path — ports cb_data_root +
   * cb_project_data_dir. If the machine config sets `data_root:`, use it
   * (with ~ expansion); otherwise use the baked default `<xdg>/projects`.
   */
  private async resolveDataDir(ctx: Context, projectId: string): Promise<string> {
    const xdg = await xdgRoot(ctx.fs, process.env, ctx.home);
    const machineConfigPath = `${xdg}/config.yml`;
    const machineText = await ctx.fs.readTextOrUndefined(machineConfigPath);
    let dataRoot = `${xdg}/projects`;  // baked default (wrapper.sh:149)
    if (machineText !== undefined) {
      const configured = parseTopLevelString(machineText, "data_root");
      if (configured !== undefined) {
        // ~ expansion — matches cb_expand_path at wrapper.sh:185.
        dataRoot = configured.startsWith("~/") ? `${ctx.home}/${configured.slice(2)}`
                 : configured === "~"           ? ctx.home
                 : configured;
      }
    }
    return `${dataRoot}/${projectId}/claude`;
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

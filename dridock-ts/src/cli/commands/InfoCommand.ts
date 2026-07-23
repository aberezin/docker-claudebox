import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext, projectContext, projectProfile, INFRA_PROFILE } from "../../infra/Docker.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { ContainerRuntime } from "../../infra/ContainerRuntime.ts";
import { RealContainerRuntime } from "../../infra/ContainerRuntime.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import { containerName } from "../../services/ContainerName.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";

/**
 * `dridock info` — human-facing at-a-glance for the current project. Ports
 * cb_info at wrapper.sh:1164. Also serves as `dridock status` (alias).
 *
 * Full P4c coverage: versions + workspace/paths + VM status +
 * container status + network block (VM IP + hostname + /etc/hosts
 * status) + machine block (cb-infra status). No more Phase-3 stubs.
 */
export class InfoCommand implements Command {
  readonly verb: "info" | "status";

  constructor(
    verb: "info" | "status" = "info",
    private readonly imageName = "dridock:latest",
    private readonly dockerOverride?: Docker,
    private readonly gitOverride?: GitToplevel,
    private readonly colimaOverride?: Colima,
    private readonly runtimeOverride?: ContainerRuntime,
  ) {
    this.verb = verb;
  }

  async run(_args: string[], ctx: Context): Promise<number> {
    const docker = this.dockerOverride ?? new RealDocker();
    const git = this.gitOverride ?? new RealGitToplevel();
    const colima = this.colimaOverride ?? new RealColima();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectCfg = new ProjectConfig(ctx.fs);
    const projectId = await projectCfg.projectId(project.configPath);

    ctx.stdout.write(`dridock — info\n\n`);

    // ── versions ────────────────────────────────────────────────────────
    ctx.stdout.write(`versions:\n`);
    ctx.stdout.write(`  wrapper (host):    ${DRIDOCK_TS_VERSION}   (${ctx.binName}-ts)\n`);
    ctx.stdout.write(`  image (cb-infra):  ${await docker.imageVersion(infraContext(), this.imageName)}\n`);
    if (projectId !== undefined) {
      ctx.stdout.write(`  image (project):   ${await docker.imageVersion(projectContext(projectId), this.imageName)}\n`);
      ctx.stdout.write(`  claude CLI (image): ${await docker.imageClaudeCliVersion(projectContext(projectId), this.imageName)}\n`);
    }
    ctx.stdout.write(`\n`);

    // ── project ─────────────────────────────────────────────────────────
    ctx.stdout.write(`project:\n`);
    ctx.stdout.write(`  workspace:         ${project.root}\n`);
    if (projectId === undefined) {
      ctx.stdout.write(`  (not a dridock project yet — run '${ctx.binName} start' here to initialize)\n\n`);
    } else {
      const profile = projectProfile(projectId);
      const vm = await colima.get(profile);
      const vmStatus = vm?.status ?? "absent";
      ctx.stdout.write(`  project id:        ${projectId}\n`);
      ctx.stdout.write(`  VM:                ${profile}   (${vmStatus})\n`);
      ctx.stdout.write(`  config.yml:        ${project.configPath}\n`);
      await this.renderSecretsRow(project.dotDir, ctx);
      const dataDir = await new MachineConfig(ctx.fs, process.env, ctx.home).projectDataDir(projectId);
      ctx.stdout.write(`  data dir:          ${dataDir}   (session/settings/plugins)\n`);

      // Container status — only queryable when the VM is up (docker
      // --context can't reach a stopped VM's daemon). Uses psFilter
      // (which runs `docker ps --format '{{.Status}}'`) for the
      // human-readable "Up 3 minutes" text rather than containerIdentity
      // (which returns just "running"/"exited" from
      // `.State.Status`). Arfy #38 P4c B2 caught the ugly "<none>"
      // rendering — psFilter matches bash cb_info at :1193.
      const cname = containerName(ctx.cwd);
      const ctxDocker = projectContext(projectId);
      if (vmStatus === "Running") {
        const runtime = this.runtimeOverride ?? new RealContainerRuntime();
        const container = await runtime.psFilter(ctxDocker, cname);
        const status = container !== undefined ? container.status : "<none>";
        ctx.stdout.write(`  container:         ${cname}   ${status}\n`);
      } else {
        ctx.stdout.write(`  container:         ${cname}   (VM not running — status unavailable)\n`);
      }
      ctx.stdout.write(`\n`);

      // ── network ────────────────────────────────────────────────────
      ctx.stdout.write(`network:\n`);
      if (vm !== undefined && vm.address !== "") {
        ctx.stdout.write(`  VM IP:             ${vm.address}\n`);
        ctx.stdout.write(`  browse:            http://${vm.address}:<port>   (or http://localhost:<port>, collides across projects)\n`);
      } else {
        ctx.stdout.write(`  VM IP:             (VM not running — start with '${ctx.binName} start')\n`);
      }
      const hostname = await projectCfg.networkHostname(project.configPath);
      if (hostname !== undefined && hostname !== "") {
        ctx.stdout.write(`  hostname:          ${hostname}   → http://${hostname}:<port>   ('${ctx.binName} net' for the /etc/hosts line)\n`);
      } else {
        ctx.stdout.write(`  hostname:          (unset — set network.hostname in config.yml for a friendly name)\n`);
      }
      ctx.stdout.write(`  cb-net:            cb-net   (attach sibling workloads: docker run --network cb-net ...)\n`);
      ctx.stdout.write(`\n`);
    }

    // ── machine ─────────────────────────────────────────────────────────
    ctx.stdout.write(`machine:\n`);
    const infraStatus = (await colima.get(INFRA_PROFILE))?.status ?? "absent";
    ctx.stdout.write(`  cb-infra:          ${infraStatus}   (image store)\n`);
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

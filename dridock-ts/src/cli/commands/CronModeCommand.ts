import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { ContainerRuntime, RunArgs } from "../../infra/ContainerRuntime.ts";
import { RealContainerRuntime } from "../../infra/ContainerRuntime.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, projectContext, projectProfile } from "../../infra/Docker.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import { VmEnsureService } from "../../services/VmEnsureService.ts";
import { ImageEnsureService } from "../../services/ImageEnsureService.ts";
import { containerName } from "../../services/ContainerName.ts";
import { collectEnvPassthrough, collectMountPassthrough } from "../../services/EnvMountPassthrough.ts";
import { xdgRoot } from "../../domain/paths.ts";
import { scanOrphans, formatLaunchWarning } from "../../services/OrphanSessionScanner.ts";

/**
 * `DRIDOCK_MODE_CRON=1 dridock [stop]` — long-running cron daemon
 * container path. Ports wrapper.sh:3067-3110.
 *
 * Bash intercepts on the env var REGARDLESS of the first positional arg —
 * only `stop` is meaningful (stops the cron container); anything else
 * (bare invocation, or a stray verb) starts / resumes the cron
 * container. main.ts calls into this AHEAD of registry dispatch to
 * match that "env var wins" precedence.
 *
 * The container's name is `${containerName(cwd)}_cron` — a sibling of
 * the interactive claudebot's container, sharing the same mounts +
 * base env. The entrypoint dispatches to cron.py because
 * `DRIDOCK_MODE_CRON=1` is set (see entrypoint.sh mode dispatch).
 */
export class CronModeCommand implements Command {
  readonly verb = "start" as const; // intercepted BEFORE verb dispatch — verb field is nominal.

  constructor(
    private readonly imageName = "dridock:latest",
    private readonly deps: Partial<CronModeDeps> = {},
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — cron mode needs a project context (${project.dotName}/config.yml missing).\n`);
      return 1;
    }

    const cronName = containerName(ctx.cwd, "cron");
    const ctxDocker = projectContext(id);
    const colima = this.deps.colima ?? new RealColima();
    const docker = this.deps.docker ?? new RealDocker();
    const runtime = this.deps.runtime ?? new RealContainerRuntime();

    // #42 tightening — every launch sanity-checks its id (same as
    // StartCommand). `stop` skips this: stopping the local cron daemon
    // is orthogonal to session-state ownership, so no need to nag.
    if (args[0] !== "stop") {
      const orphans = await scanOrphans({ fs: ctx.fs, env: process.env, home: ctx.home }, ctx.cwd, id);
      if (orphans.length > 0) {
        for (const line of formatLaunchWarning(id, orphans)) ctx.stderr.write(line);
      }
    }

    // `stop` sub-branch — mirrors wrapper.sh:3074-3084.
    if (args[0] === "stop") {
      const running = await this.isProfileRunning(colima, projectProfile(id));
      const ps = running ? await runtime.psFilter(ctxDocker, cronName) : undefined;
      if (ps === undefined || !ps.status.startsWith("Up")) {
        ctx.stdout.write(`cron not running\n`);
        return 0;
      }
      await runtime.stop(ctxDocker, cronName);
      ctx.stdout.write(`stopped ${cronName}\n`);
      return 0;
    }

    // Ensure VM + image (auto-seed from cb-infra if drift/absent) — same
    // shape as StartCommand so a cold-start cron invocation Just Works.
    const imageEnsure = new ImageEnsureService({ colima, docker, image: this.imageName });
    const vmEnsure = new VmEnsureService({
      colima, docker, fs: ctx.fs, env: process.env, home: ctx.home, image: this.imageName,
      ensureImage: imageEnsure.asCallback(),
    });
    const vmOutcome = await vmEnsure.ensure(project.root, id);
    switch (vmOutcome.kind) {
      case "guard-refused":
        ctx.stderr.write(`❌ ${vmOutcome.detail}\n`);
        return 1;
      case "start-failed":
        ctx.stderr.write(`❌ VM start failed: ${vmOutcome.reason}\n`);
        return 1;
      case "no-reachable-ip":
        ctx.stderr.write(`❌ ${vmOutcome.attemptedProfile} started but no reachable IP after wait — try again in a moment.\n`);
        return 1;
      case "started": case "already-running": break;
    }

    // "cron already running" idempotent branch — matches wrapper.sh:3086.
    const existing = await runtime.psFilter(ctxDocker, cronName);
    if (existing !== undefined && existing.status.startsWith("Up")) {
      ctx.stdout.write(`cron already running (${cronName})\n`);
      ctx.stdout.write(`  docker --context ${ctxDocker} logs -f ${cronName}\n`);
      return 0;
    }

    // Resume path — container exists but stopped: `docker start` (no -a).
    if (existing !== undefined) {
      ctx.stdout.write(`restarting cron container (${cronName})...\n`);
      const rc = await runtime.startBackground(ctxDocker, cronName);
      if (rc === 0) ctx.stdout.write(`  docker --context ${ctxDocker} logs -f ${cronName}\n`);
      return rc;
    }

    // Fresh spawn — `docker run -d`.
    const machine = new MachineConfig(ctx.fs, process.env, ctx.home);
    const dataDir = await machine.projectDataDir(id);
    await ctx.fs.mkdirRecursive(dataDir);

    const envPassthrough = collectEnvPassthrough(process.env);
    const mountPassthrough = collectMountPassthrough(process.env);
    const xdg = await xdgRoot(ctx.fs, process.env, ctx.home);
    await ctx.fs.mkdirRecursive(`${xdg}/framework-bugs`);
    await ctx.fs.mkdirRecursive(`${xdg}/consult`);

    const cronFile = process.env["DRIDOCK_MODE_CRON_FILE"] ?? process.env["CLAUDE_MODE_CRON_FILE"];
    const runArgs: RunArgs = {
      context: ctxDocker,
      containerName: cronName,
      image: this.imageName,
      mode: "detached",
      network: "host",
      mounts: [
        { host: process.env["DRIDOCK_SSH_DIR"] ?? process.env["CLAUDEBOX_SSH_DIR"] ?? `${ctx.home}/.ssh/claudebox`, container: "/home/claude/.ssh" },
        { host: dataDir, container: "/home/claude/.claude" },
        { host: ctx.cwd, container: ctx.cwd },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
        { host: `${xdg}/framework-bugs`, container: "/home/claude/framework-bugs" },
        { host: `${xdg}/consult`, container: "/home/claude/framework-consult" },
        ...mountPassthrough.mountAdditions,
      ],
      env: [
        // The signal that makes entrypoint.sh dispatch to cron.py.
        { key: "DRIDOCK_MODE_CRON", value: "1" },
        { key: "DRIDOCK_WORKSPACE", value: ctx.cwd },
        { key: "DRIDOCK_CONTAINER_NAME", value: cronName },
        ...(cronFile !== undefined && cronFile !== "" ? [{ key: "DRIDOCK_MODE_CRON_FILE", value: cronFile }] : []),
        ...(process.env["DEBUG"] === "true" ? [{ key: "DEBUG", value: "true" }] : []),
        ...envPassthrough.envAdditions,
      ],
      cmd: [],
      publishPorts: [],
    };
    ctx.stdout.write(`starting cron container (${cronName})...\n`);
    const rc = await runtime.runInteractive(runArgs);
    if (rc === 0) ctx.stdout.write(`  docker --context ${ctxDocker} logs -f ${cronName}\n`);
    return rc;
  }

  private async isProfileRunning(colima: Colima, profile: string): Promise<boolean> {
    const vms = await colima.list();
    return vms.some((v) => v.name === profile && v.status === "Running");
  }
}

export interface CronModeDeps {
  readonly colima: Colima;
  readonly docker: Docker;
  readonly runtime: ContainerRuntime;
  readonly git: GitToplevel;
}

/**
 * True when `DRIDOCK_MODE_CRON` (or legacy `CLAUDE_MODE_CRON`) is set and
 * non-empty. Exported so main.ts can intercept BEFORE the verb registry —
 * matches bash's `if [ -n "$_mode_cron" ]` at wrapper.sh:3070 which fires
 * regardless of the first positional arg.
 */
export function cronModeRequested(env: Record<string, string | undefined>): boolean {
  const v = env["DRIDOCK_MODE_CRON"] ?? env["CLAUDE_MODE_CRON"];
  return v !== undefined && v !== "";
}

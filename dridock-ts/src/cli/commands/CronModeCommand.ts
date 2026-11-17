import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { ContainerRuntime, RunArgs } from "../../infra/ContainerRuntime.ts";
import { RealContainerRuntime } from "../../infra/ContainerRuntime.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, projectContext, projectProfile, WORKSPACE_LABEL, ID_LABEL } from "../../infra/Docker.ts";
import { ContainerRefresher, shortId } from "../../services/ContainerRefresher.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import { checkWorkspaceMove } from "../../services/WorkspaceMoveReporter.ts";
import { VmEnsureService } from "../../services/VmEnsureService.ts";
import { realSpinner } from "../../infra/Spinner.ts";
import { ImageEnsureService, parseForceReseed } from "../../services/ImageEnsureService.ts";
import { containerName, legacyContainerName, withRole } from "../../services/ContainerName.ts";
import { guardWorkspace, notRootMessage } from "../../services/WorkspaceGuard.ts";
import { resolveIdentity } from "../../services/ProjectIdentity.ts";
import { AdoptionService } from "../../services/AdoptionService.ts";
import { collectEnvPassthrough, collectMountPassthrough } from "../../services/EnvMountPassthrough.ts";
import { xdgRoot } from "../../domain/paths.ts";
import { scanOrphans, formatLaunchWarning } from "../../services/OrphanSessionScanner.ts";
import { checkInfraDrift } from "../../services/InfraDriftWarning.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";
import type { ImageChoice } from "../../domain/ImageRef.ts";

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
  readonly usage = `dridock start (cron mode)

Long-running cron daemon container for this project, driven by cron.yml.
Intercepted before verb dispatch, so this text is reached via the cron path.`;

  constructor(
    private readonly imageName = "dridock:latest",
    private readonly deps: Partial<CronModeDeps> = {},
    /** How imageName was chosen (ImageRef); picks the drift warning's remedy. */
    private readonly imageVariant: ImageChoice["variant"] = "full",
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const isStop = args[0] === "stop";
    // Launching mounts the workspace, so it runs only from the root (#123).
    // `cron stop` mounts nothing and may run from anywhere in the project.
    const projectCfg = new ProjectConfig(ctx.fs);
    const id = await projectCfg.projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — cron mode needs a project context (${project.dotName}/config.yml missing).\n`);
      return 1;
    }
    if (!isStop) {
      const guard = guardWorkspace(ctx.cwd, ctx.env.raw(), project.root);
      for (const n of guard.notes) ctx.stderr.write(n);
      if (guard.kind === "not-root") {
        ctx.stderr.write(notRootMessage(ctx.cwd, guard.root, ctx.binName, "cron"));
        return 1;
      }
    }
    const ident = await resolveIdentity(projectCfg, project, id, isStop ? "read-only" : "adopt", (m) => ctx.stderr.write(m));

    let cronName = containerName(ident, "cron");
    const ctxDocker = projectContext(id);
    const colima = this.deps.colima ?? new RealColima();
    const docker = this.deps.docker ?? new RealDocker();
    const runtime = this.deps.runtime ?? new RealContainerRuntime();

    // #42 tightening — every launch sanity-checks its id (same as
    // StartCommand). `stop` skips this: stopping the local cron daemon
    // is orthogonal to session-state ownership, so no need to nag.
    if (args[0] !== "stop") {
      const orphans = await scanOrphans({ fs: ctx.fs, env: ctx.env.raw(), home: ctx.home }, ctx.cwd, id);
      if (orphans.length > 0) {
        for (const line of formatLaunchWarning(id, orphans)) ctx.stderr.write(line);
      }
    }

    // `stop` sub-branch — mirrors wrapper.sh:3074-3084.
    if (args[0] === "stop") {
      const running = await this.isProfileRunning(colima, projectProfile(id));
      let ps = running ? await runtime.psFilter(ctxDocker, cronName) : undefined;
      if (running && ps === undefined) {
        // Not adopted yet (#123): the pre-6.0 name is what's running.
        const legacy = legacyContainerName(project.root, "cron");
        ps = await runtime.psFilter(ctxDocker, legacy);
        if (ps !== undefined) cronName = legacy;
      }
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
    const imageEnsure = new ImageEnsureService({
      colima, docker, image: this.imageName,
      warn: (m) => ctx.stderr.write(m),
      force: parseForceReseed(ctx.env.get("FORCE_RESEED"), (m) => ctx.stderr.write(m)),
      // #48: the save|load is the one window a cold start still sat silent
      // through. isTty is read off the real stderr, so redirected output
      // gets the completion line without the animation frames.
      progress: realSpinner({ write: (m) => ctx.stderr.write(m) }, process.stderr.isTTY === true),
    });
    const vmEnsure = new VmEnsureService({
      colima, docker, fs: ctx.fs, env: ctx.env.raw(), home: ctx.home, image: this.imageName,
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

    // #110: same launch-time drift warning as `start` (3.x ran it on both).
    for (const line of await checkInfraDrift(
      { docker, fs: ctx.fs, env: ctx.env }, project.root,
      { wrapperVersion: DRIDOCK_TS_VERSION, image: this.imageName, variant: this.imageVariant, binName: ctx.binName },
    )) ctx.stderr.write(line);

    // Adopt pre-6.0 / moved containers before touching this role (#123).
    const machine = new MachineConfig(ctx.fs, ctx.env.raw(), ctx.home);
    const dataDir = await machine.projectDataDir(id);
    await ctx.fs.mkdirRecursive(dataDir);

    // #133: a project move orphans cron's per-job history, which is a
    // scheduled job's ONLY memory of its last run (jobs get no --continue, so
    // the history hint built from the previous run's dir is all there is). The
    // host never reported it: checkWorkspaceMove was wired into `start` alone.
    //
    // WARN AND KEEP LAUNCHING, deliberately, where `start` returns 1. A cron
    // daemon that refuses to start runs NO jobs, possibly for days, with
    // nobody at the terminal to read the refusal — strictly worse than running
    // them without their prior-run hint, which only degrades jobs that compare
    // against yesterday. Same reasoning as #136's roster warning and #138's
    // in-container drift note: for the unattended role, loud beats fatal.
    const move = await checkWorkspaceMove(ctx.fs, {
      stateRoot: await machine.projectRoot(id), dataDir, root: project.root, binName: ctx.binName,
      caller: "cron",
    });
    if (move.kind === "moved") ctx.stderr.write(move.message);
    const adoption = await new AdoptionService(docker, ctx.fs).adopt({
      context: ctxDocker, root: project.root, ident, dataDir, binName: ctx.binName,
    });
    if (adoption.kind === "refused") {
      ctx.stderr.write(adoption.message);
      return 1;
    }
    for (const n of adoption.notes) ctx.stderr.write(n);
    if (adoption.kind === "deferred") cronName = withRole(adoption.legacyBase, "cron");

    // #138: cron used to restart its own container as is, so a cron daemon
    // kept the image it was created from forever (old entrypoint, cron.py,
    // cb-*), and since #118 the project image moves routinely. Same rule as
    // start (#126): a stale STOPPED container is recreated; a stale RUNNING
    // one is never killed. cron.py also notices on its own and says so in
    // `docker logs` (the long-lived daemon that is never stopped is the case
    // this branch can't reach).
    const refresh = await new ContainerRefresher(docker).maybeRefresh(ctxDocker, cronName, this.imageName);
    if (refresh.kind === "recreated") {
      ctx.stderr.write(`🔄 recreating cron container ${cronName} (image drifted)\n`);
    } else if (refresh.kind === "running" || refresh.kind === "remove-failed") {
      const how = refresh.kind === "running" ? `is ${refresh.status}` : `couldn't be removed (docker rm rc ${refresh.rc})`;
      ctx.stderr.write(`❌ cron container ${cronName} ${how} on an older image (${shortId(refresh.from)}; the project image is now ${shortId(refresh.to)}).\n`);
      ctx.stderr.write(`   Not stopping it mid-schedule. To move it to the new image, stop it, then start cron again:\n`);
      ctx.stderr.write(`     DRIDOCK_MODE_CRON=1 ${ctx.binName} stop\n`);
      return 1;
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

    const envPassthrough = collectEnvPassthrough(ctx.env.raw());
    const mountPassthrough = collectMountPassthrough(ctx.env.raw());
    const xdg = await xdgRoot(ctx.fs, ctx.env.raw(), ctx.home);
    await ctx.fs.mkdirRecursive(`${xdg}/framework-bugs`);
    await ctx.fs.mkdirRecursive(`${xdg}/consult`);

    const cronFile = ctx.env.raw()["DRIDOCK_MODE_CRON_FILE"];
    const runArgs: RunArgs = {
      context: ctxDocker,
      containerName: cronName,
      image: this.imageName,
      labels: [{ key: WORKSPACE_LABEL, value: project.root }, { key: ID_LABEL, value: id }],
      mode: "detached",
      network: "host",
      mounts: [
        { host: ctx.env.raw()["DRIDOCK_SSH_DIR"] ?? `${ctx.home}/.ssh/claudebox`, container: "/home/claude/.ssh" },
        { host: dataDir, container: "/home/claude/.claude" },
        { host: project.root, container: project.root },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
        { host: `${xdg}/framework-bugs`, container: "/home/claude/framework-bugs" },
        { host: `${xdg}/consult`, container: "/home/claude/framework-consult" },
        ...mountPassthrough.mountAdditions,
      ],
      env: [
        // The signal that makes entrypoint.sh dispatch to cron.py.
        { key: "DRIDOCK_MODE_CRON", value: "1" },
        { key: "DRIDOCK_WORKSPACE", value: project.root },
        { key: "DRIDOCK_CONTAINER_NAME", value: cronName },
        ...(cronFile !== undefined && cronFile !== "" ? [{ key: "DRIDOCK_MODE_CRON_FILE", value: cronFile }] : []),
        ...(ctx.env.raw()["DEBUG"] === "true" ? [{ key: "DEBUG", value: "true" }] : []),
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
 * True when `DRIDOCK_MODE_CRON` is set and
 * non-empty. Exported so main.ts can intercept BEFORE the verb registry —
 * matches bash's `if [ -n "$_mode_cron" ]` at wrapper.sh:3070 which fires
 * regardless of the first positional arg.
 */
export function cronModeRequested(env: Record<string, string | undefined>): boolean {
  const v = env["DRIDOCK_MODE_CRON"];
  return v !== undefined && v !== "";
}

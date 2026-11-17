import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { ContainerRuntime, RunArgs } from "../../infra/ContainerRuntime.ts";
import { RealContainerRuntime } from "../../infra/ContainerRuntime.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, projectContext, projectProfile, WORKSPACE_LABEL, ID_LABEL } from "../../infra/Docker.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { HostGit } from "../../infra/HostGit.ts";
import { RealHostGit } from "../../infra/HostGit.ts";
import type { ProcessProbe } from "../../infra/ProcessProbe.ts";
import { RealProcessProbe } from "../../infra/ProcessProbe.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig, legacyLocationNotice } from "../../services/ProjectConfig.ts";
import { containerName, withRole, type ContainerRole } from "../../services/ContainerName.ts";
import { guardWorkspace, notRootMessage } from "../../services/WorkspaceGuard.ts";
import { resolveIdentity } from "../../services/ProjectIdentity.ts";
import { AdoptionService } from "../../services/AdoptionService.ts";
import { checkWorkspaceMove } from "../../services/WorkspaceMoveReporter.ts";
import { validateProgArgs } from "../../services/ProgArgValidator.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import { VmEnsureService } from "../../services/VmEnsureService.ts";
import { realSpinner } from "../../infra/Spinner.ts";
import { ImageEnsureService, parseForceReseed } from "../../services/ImageEnsureService.ts";
import { ContainerRefresher, staleRunningMessage } from "../../services/ContainerRefresher.ts";
import { SidecarWriter } from "../../services/SidecarWriter.ts";
import { AuthSecretsProvisioner } from "../../services/AuthSecretsProvisioner.ts";
import { collectEnvPassthrough, collectMountPassthrough } from "../../services/EnvMountPassthrough.ts";
import { BridgeStateReader } from "../../services/BridgeStateReader.ts";
import { DotDirMigrator } from "../../services/DotDirMigrator.ts";
import { DotMountGate } from "../../services/DotMountGate.ts";
import { dotExclusionVolumes } from "../../services/DotExclusions.ts";
import { xdgRoot } from "../../domain/paths.ts";
import { CLAUDE_CLI_REMOTE_CONTROL_FLOOR } from "../../domain/dridockVersion.ts";
import { Version } from "../../domain/Version.ts";
import { IMAGE_UNAVAILABLE, IMAGE_UNSTAMPED } from "../../infra/Docker.ts";
import { scanOrphans, formatLaunchWarning } from "../../services/OrphanSessionScanner.ts";
import { loadRoster, soleAgentByEnvironment } from "../../services/AgentRoster.ts";
import { checkInfraDrift } from "../../services/InfraDriftWarning.ts";
import { maybeCaffeinate, RealKeepAwake, type KeepAwake } from "../../services/Caffeinate.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";
import { makeTargetFor, type ImageChoice } from "../../domain/ImageRef.ts";

/**
 * `dridock start` — the main launch verb. Full port; no bash fallback.
 *
 * Composes:
 *   - guards: workspace (not-in-dotdir), projectId presence
 *   - `-p` arg validation BEFORE any side effect (allowlist)
 *   - VmEnsureService: profile guard → count limit → colima start → wait-reachable
 *   - ImageEnsureService (via VmEnsure callback): first-seed or drift-reseed
 *   - Every sidecar the entrypoint reads: auth, secrets, env, cdp,
 *     hostagent, vmip, features, --update, --no-continue, args
 *   - ContainerRefresher: recreate when image changed
 *   - Container reuse: existing → `docker start -a`(i); missing → `docker run`
 *
 * All argv-parity items from wrapper.sh:2812 DOCKER_ARGS are here.
 * Deferred (harmless, documented): auto-continue fresh-session fallback
 * is entrypoint-side (this wrapper writes only the `-no-continue`
 * sidecar), --update is now honored.
 */
export class StartCommand implements Command {
  readonly verb = "start" as const;
  readonly usage = `dridock start [claude args…]

Launch claudebot for this project — ensures the VM, seeds/reseeds the image,
then runs claude. Unrecognised args are forwarded to claude; in programmatic
mode (-p) they are validated against an allowlist first.

  -p / --print   programmatic (non-interactive) mode`;

  constructor(
    private readonly imageName = "dridock:latest",
    private readonly deps: Partial<StartDeps> = {},
    /** How imageName was chosen (ImageRef); picks the drift warning's remedy. */
    private readonly imageVariant: ImageChoice["variant"] = "full",
  ) {}

  async run(args: string[], ctx: Context): Promise<number> {
    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);

    const projectCfg = new ProjectConfig(ctx.fs);
    const id = await projectCfg.projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — run '${ctx.binName} bootstrap' to scaffold ${project.dotName}/config.yml first.\n`);
      return 1;
    }

    // ── guard: launch only from the project root (#123) ───────────────
    // After the sentinel check, so a plain git subdirectory gets "no dridock
    // project here", not a root that isn't one. A subdirectory would land in
    // the root's container while asking to mount a different path. Subsumes
    // the pre-6.0 `.dridock`-dir guard.
    const guard = guardWorkspace(ctx.cwd, ctx.env.raw(), project.root);
    for (const n of guard.notes) ctx.stderr.write(n);
    if (guard.kind === "not-root") {
      ctx.stderr.write(notRootMessage(ctx.cwd, guard.root, ctx.binName, "start"));
      return 1;
    }
    const ident = await resolveIdentity(projectCfg, project, id, "adopt", (m) => ctx.stderr.write(m));
    // Liveness signal — the biggest UX complaint on 4.0.0 was that
    // `dridock start` printed NOTHING until claude appeared, which felt
    // hung on a warm-path launch (VM up, container exists → sub-second
    // to claude UI) and *really* hung on a cold-path reseed (15-45s of
    // silent `docker save | docker load`). See #48. This line gives
    // the user immediate confirmation dridock received the command;
    // subsequent phase lines below narrate the slow ones.
    ctx.stderr.write(`🚀 dridock start (project: ${id})\n`);
    // #42 tightening — every launch sanity-checks its id against sibling
    // session dirs. Catches "config.yml's id got clobbered onto an empty
    // dir; the real sessions live under some OTHER id" (the exact incident
    // #42 documents from the user side). Warning-only: bash-parity, we
    // continue with the configured id; user decides whether to abort +
    // adopt an existing one. Called BEFORE any container/VM side effect.
    const startOrphans = await scanOrphans({ fs: ctx.fs, env: ctx.env.raw(), home: ctx.home }, ctx.cwd, id);
    if (startOrphans.length > 0) {
      for (const line of formatLaunchWarning(id, startOrphans)) ctx.stderr.write(line);
    }

    // ── mode detect + programmatic validation (BEFORE any side effect) ─
    const isProg = args.some((a) => a === "-p" || a === "--print");
    let validated: ReturnType<typeof validateProgArgs> | undefined;
    if (isProg) validated = validateProgArgs(args);

    // ── VM ensure (cold-start if needed, image seed/reseed) ────────────
    const colima = this.deps.colima ?? new RealColima();
    const docker = this.deps.docker ?? new RealDocker();
    const runtime = this.deps.runtime ?? new RealContainerRuntime();
    const hostGit = this.deps.hostGit ?? new RealHostGit();
    const probe = this.deps.probe ?? new RealProcessProbe();

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
      case "started":
        if (vmOutcome.warned) ctx.stderr.write(`⚠️  running near VM limit — starting anyway.\n`);
        // Colima's own output streamed above during the cold start
        // (RealColima.start inherits stdio). This is the confirmation
        // line so the user knows the VM is now reachable and dridock
        // is moving on to the container.
        ctx.stderr.write(`✓ VM ${projectProfile(id)} ready (${vmOutcome.ip})\n`);
        break;
      case "already-running":
        // Skip the "already running" narration — warm-path launches
        // are dominated by the container spawn line below; adding a
        // VM confirmation here is noise for the common case.
        break;
    }
    const vmIp = vmOutcome.kind === "started" || vmOutcome.kind === "already-running" ? vmOutcome.ip : "";

    // #110: warn (never block) when cb-infra's copy of the image this run
    // uses is out of step with this wrapper. After VM ensure, so a cb-infra
    // that the ensure just booted is readable rather than silently skipped.
    for (const line of await checkInfraDrift(
      { docker, fs: ctx.fs, env: ctx.env }, project.root,
      { wrapperVersion: DRIDOCK_TS_VERSION, image: this.imageName, variant: this.imageVariant, binName: ctx.binName },
    )) ctx.stderr.write(line);

    // ── Resolve per-project data dir + sidecar writer ─────────────────
    const machine = new MachineConfig(ctx.fs, ctx.env.raw(), ctx.home);

    // #80 phase 2: fold ~/.claude into the per-project dot dir, then decide
    // whether it is safe to mount that dir over $HOME. Migration runs BEFORE
    // projectDataDir is read, because that getter now points at the NEW
    // location — reading it first would silently create an empty dir beside
    // 27 MB of live sessions and mount the empty one.
    let dataDirMoved = false;
    const dotDir = await machine.projectDotDir(id);
    if (dotDir !== undefined) {
      const projectRoot = dotDir.replace(/\/dot$/, "");
      const migrator = new DotDirMigrator(ctx.fs);
      // #126: the move recreates every container afterwards, and moving a
      // live session's data out from under it is worse. So when there is
      // something to move, check first and refuse while any of this
      // project's containers (cron included) is running. Nothing has
      // changed at that point, so the next start simply tries again.
      if (await migrator.wouldMove(projectRoot)) {
        const all = await docker.listContainers(projectContext(id), "claude-");
        if (all === undefined) {
          ctx.stderr.write(`❌ dridock: this project's ~/.claude data needs moving (#80), and docker couldn't be asked\n`);
          ctx.stderr.write(`   whether a container is running on it. Nothing was moved; try again.\n`);
          return 1;
        }
        const live = all.filter((c) => c.state === "running").map((c) => c.name);
        if (live.length > 0) {
          ctx.stderr.write(`❌ dridock: this project's ~/.claude data needs moving (#80), and ${live.join(", ")} ${live.length === 1 ? "is" : "are"} running on it.\n`);
          ctx.stderr.write(`   Not moving a live session's data, so nothing was changed. End that session, then:\n`);
          ctx.stderr.write(`     ${ctx.binName} down && ${ctx.binName} start\n`);
          return 1;
        }
      }
      const moved = await migrator.migrate(projectRoot);
      if (moved.kind === "failed") {
        ctx.stderr.write(`❌ dridock: cannot migrate this project's ~/.claude data.\n`);
        ctx.stderr.write(`   ${moved.reason}\n`);
        return 1;
      }
      if (moved.kind === "migrated") {
        ctx.stderr.write(`📦 moved ${moved.from} → ${moved.to} (dotfiles now persist across recreate)\n`);
        dataDirMoved = true;
      }
    }

    const dataDir = await machine.projectDataDir(id);
    await ctx.fs.mkdirRecursive(dataDir);
    const ctxDocker = projectContext(id);

    // ── the project moved? Claude's session history didn't (#123) ─────
    const moved = await checkWorkspaceMove(ctx.fs, {
      stateRoot: await machine.projectRoot(id), dataDir, root: project.root, binName: ctx.binName,
      caller: "start",
    });
    if (moved.kind === "moved") {
      ctx.stderr.write(moved.message);
      return 1;
    }

    // ── adopt pre-6.0 / moved containers (#123) ───────────────────────
    // Before any sidecar is written: adoption decides which names this run
    // uses, and clears sidecars under names nothing will read again.
    const adoption = await new AdoptionService(docker, ctx.fs).adopt({
      context: ctxDocker, root: project.root, ident, dataDir, binName: ctx.binName,
    });
    if (adoption.kind === "refused") {
      ctx.stderr.write(adoption.message);
      return 1;
    }
    for (const n of adoption.notes) ctx.stderr.write(n);
    // Deferred = a pre-6.0 container is running: keep its names this run.
    const nameFor = (role: ContainerRole): string => adoption.kind === "deferred"
      ? withRole(adoption.legacyBase, role)
      : containerName(ident, role);
    const cnameBase = nameFor("interactive");
    const sidecars = new SidecarWriter(ctx.fs, dataDir, cnameBase);

    // ── Provision every sidecar the entrypoint reads ──────────────────
    const auth = new AuthSecretsProvisioner(ctx.fs, sidecars, ctx.env.raw(), dataDir);
    await auth.writeAuthSidecars();
    await auth.writeSecretsSidecars(`${project.dotDir}/secrets.env`);
    // features:/plugins: resolve across BOTH config files (#97) — the tracked
    // project.yml plus the gitignored config.yml, unioned. Legacy entries are
    // applied, then named on stderr: they work, they just can't travel.
    const featuresR = await projectCfg.featuresResolved(project.configPath, project.projectPath);
    if (featuresR.legacy.length > 0) {
      ctx.stderr.write(legacyLocationNotice("features", featuresR.legacy, project.dotName));
    }
    await auth.writeFeaturesSidecar(featuresR.values);
    const pluginsR = await projectCfg.pluginsResolved(project.configPath, project.projectPath);
    if (pluginsR.legacy.length > 0) {
      ctx.stderr.write(legacyLocationNotice("plugins", pluginsR.legacy, project.dotName));
    }
    await auth.writePluginsSidecar(pluginsR.values);

    // Env passthrough (DRIDOCK_ENV_*) → both -e + sidecar
    const envPassthrough = collectEnvPassthrough(ctx.env.raw());
    await sidecars.writeAllRoles("env", envPassthrough.sidecarContent);

    // Mount passthrough (DRIDOCK_MOUNT_*) — no sidecar, mount-time only.
    const mountPassthrough = collectMountPassthrough(ctx.env.raw());

    // CDP + host-agent sidecars — always written (empty when the bridge is down).
    const bridges = new BridgeStateReader(ctx.fs, ctx.env.raw(), ctx.home, probe);
    const cdpUrl = await bridges.cdpUrl(id);
    await sidecars.writeAllRoles("cdp", cdpUrl === "" ? "" : `DRIDOCK_HOST_CDP_URL=${cdpUrl}\n`);
    const ha = await bridges.hostAgentState();
    await sidecars.writeAllRoles("hostagent",
      `DRIDOCK_HOST_AGENT_URL=${ha.url}\nDRIDOCK_HOST_AGENT_TOKEN=${ha.token}\n`);

    // VM-IP sidecar — self-heal on IP rotation across `docker start`
    const hostname = (await projectCfg.networkHostname(project.configPath)) ?? "";
    await sidecars.writeAllRoles("vmip",
      `DRIDOCK_VM_IP=${vmIp}\nDRIDOCK_HOSTNAME=${hostname}\n`);

    // ── ContainerRefresher: recreate if image drifted ────────────────

    // #80 phase 2: decide the $HOME mount only AFTER VmEnsure has seeded /
    // reseeded the image, since the gate reads that image's version label. A
    // skip is announced, not silent: "my git config vanished again" with no
    // explanation is the exact experience this feature exists to end.
    let dotMount: string | undefined;
    if (dotDir !== undefined) {
      const decision = await new DotMountGate(docker, this.imageName).decide(ctxDocker);
      if (decision.kind === "mount") {
        dotMount = dotDir;
      } else {
        ctx.stderr.write(`!  dotfile persistence off: ${decision.reason}.\n   ${decision.note}\n`);
      }
    }

    // A migration moved the mount SOURCE, so every existing container is now
    // pointing at a path that no longer exists. Docker does not error on that —
    // it silently recreates the missing source as an EMPTY directory, and the
    // agent wakes with no memory at all ("let's get started", asking to pick a
    // text style, while 25 MB of its history sits untouched at the new path).
    //
    // `dridock down` stops without removing, so a plain down/start reattaches
    // to that stale container and reproduces it every time. ContainerRefresher
    // only knows about IMAGE drift; a mount-source change is invisible to it.
    // Found on gammaray during the #80 gate test — it did not show up on the
    // first project only because that upgrade also rebuilt the image, which
    // triggered a recreate for unrelated reasons.
    if (dataDirMoved) {
      // Non-force (#126): none was running when the move was checked above,
      // so a refusal here means one started since. Its mount is stale and the
      // next start won't know to recreate it (the move is done), so say
      // exactly what to remove.
      for (const name of [cnameBase, nameFor("programmatic"), nameFor("cron")]) {
        if (await docker.containerIdentity(ctxDocker, name) === undefined) continue;
        const rc = await docker.containerRemoveStopped(ctxDocker, name);
        if (rc !== 0) {
          ctx.stderr.write(`❌ ${name} started while its ~/.claude data was being moved, so its mount is stale (docker rm rc ${rc}).\n`);
          ctx.stderr.write(`   End its session, then remove it so the next start recreates it:\n`);
          ctx.stderr.write(`     docker --context ${ctxDocker} rm -f ${name}\n`);
          return 1;
        }
      }
      ctx.stderr.write(`🔄 recreating containers — the data dir moved, so their mounts are stale\n`);
    }

    // #126: a stale container that is RUNNING is left alone, and this start
    // stops there with the way forward, rather than killing a live session.
    const refresher = new ContainerRefresher(docker);
    for (const name of isProg ? [cnameBase, nameFor("programmatic")] : [cnameBase]) {
      const r = await refresher.maybeRefresh(ctxDocker, name, this.imageName);
      if (r.kind === "recreated") {
        ctx.stderr.write(`🔄 recreating container ${name} (image drifted)\n`);
      } else if (r.kind === "running" || r.kind === "remove-failed") {
        ctx.stderr.write(staleRunningMessage(name, r, ctx.binName));
        return 1;
      }
    }

    // ── --update sidecar (for `dridock -p '…' --update`) ─────────────
    if (validated?.wantsUpdate) {
      await sidecars.writeOneRole("update", "_prog", "");
    } else {
      await ctx.fs.removeFile(sidecars.pathFor("update", "_prog"));
    }
    // Interactive --update (top-level arg) — same shape:
    if (args.includes("--update") && !isProg) {
      await sidecars.writeOneRole("update", "", "");
    } else if (!isProg) {
      await ctx.fs.removeFile(sidecars.pathFor("update", ""));
    }

    // ── --no-continue sidecar (interactive path only; prog has its own flag) ─
    if (!isProg) {
      if (args.includes("--no-continue")) {
        await sidecars.writeOneRole("no-continue", "", "");
      } else {
        await ctx.fs.removeFile(sidecars.pathFor("no-continue", ""));
      }
    }

    // ── Framework-bugs + consult mount paths (host-side) ─────────────
    const xdg = await xdgRoot(ctx.fs, ctx.env.raw(), ctx.home);
    const fwbugsDir = `${xdg}/framework-bugs`;
    const consultDir = `${xdg}/consult`;
    await ctx.fs.mkdirRecursive(fwbugsDir);
    await ctx.fs.mkdirRecursive(consultDir);

    // ── DRIDOCK_GIT_NAME/EMAIL from host git config ──────────────────
    const gitName = await hostGit.configGet("user.name") ?? "";
    const gitEmail = await hostGit.configGet("user.email") ?? "";

    // ── DRIDOCK_AGENT_NAME auto-inject (#46 QOL) ──────────────────────
    // If the project has an agents.yml with exactly one agent whose
    // `environment: container`, propagate that name into the container as
    // DRIDOCK_AGENT_NAME. Skips when:
    //   - no roster (non-team project)
    //   - zero or >1 container agents in roster (ambiguous → user sets
    //     DRIDOCK_ENV_DRIDOCK_AGENT_NAME explicitly)
    //   - user already forwarded a value via DRIDOCK_ENV_DRIDOCK_AGENT_NAME
    //     (envPassthrough collected below wins — it'll appear later in
    //     baseEnv, and Docker's last-`-e`-wins semantics preserve the
    //     user's override)
    // Without this, Bear inside the container gets rc≠0 on `dridock team
    // whoami` and the team-watch hook can't route messages to him.
    let autoAgentName: string | undefined;
    const rosterPath = `${project.dotDir}/agents.yml`;
    try {
      const roster = await loadRoster(ctx.fs, rosterPath);
      if (roster !== undefined) autoAgentName = soleAgentByEnvironment(roster, "container");
    } catch (e) {
      // A bad roster mustn't stop the launch, but it mustn't cost the
      // DRIDOCK_AGENT_NAME auto-inject silently either: since #136 a 5.x
      // roster without `team:` lands here, and the agent would come up
      // without its name and no clue why.
      ctx.stderr.write(`⚠️  .dridock/agents.yml couldn't be read, so DRIDOCK_AGENT_NAME isn't set from it:\n`);
      ctx.stderr.write(`   ${e instanceof Error ? e.message : String(e)}\n`);
    }

    // ── Build the run env (all -e pairs) ─────────────────────────────
    const baseEnv: RunArgs["env"] = [
      { key: "DRIDOCK_GIT_NAME", value: gitName },
      { key: "DRIDOCK_GIT_EMAIL", value: gitEmail },
      { key: "DRIDOCK_WORKSPACE", value: project.root },
      { key: "DRIDOCK_PROJECT_ID", value: id },
      { key: "DRIDOCK_FRAMEWORK_BUGS_DIR", value: "/home/claude/framework-bugs" },
      { key: "DRIDOCK_CONSULT_DIR", value: "/home/claude/framework-consult" },
      ...(cdpUrl !== "" ? [{ key: "DRIDOCK_HOST_CDP_URL", value: cdpUrl }] : []),
      ...(vmIp !== "" ? [{ key: "DRIDOCK_VM_IP", value: vmIp }] : []),
      ...(hostname !== "" ? [{ key: "DRIDOCK_HOSTNAME", value: hostname }] : []),
      ...(autoAgentName !== undefined ? [{ key: "DRIDOCK_AGENT_NAME", value: autoAgentName }] : []),
      ...(ctx.env.raw()["DEBUG"] === "true" ? [{ key: "DEBUG", value: "true" }] : []),
      ...((): { key: string; value: string }[] => {
        const v = ctx.env.raw()["DRIDOCK_DEFAULT_PLUGINS"];
        return v !== undefined ? [{ key: "DRIDOCK_DEFAULT_PLUGINS", value: v }] : [];
      })(),
      ...envPassthrough.envAdditions,
    ];
    // tmpfs opt-in
    const tmpfsSpec = resolveTmpfs(ctx.env.raw());

    // #110: DRIDOCK_CAFFEINATE holds the Mac awake for as long as this
    // foreground process lives, which is as long as the session is attached.
    maybeCaffeinate(ctx.env, this.deps.keepAwake ?? new RealKeepAwake(), process.pid, ctx.stderr);

    // ── mode dispatch ─────────────────────────────────────────────────
    const labels = [{ key: WORKSPACE_LABEL, value: project.root }, { key: ID_LABEL, value: id }];
    if (isProg) return await this.runProgrammatic(nameFor("programmatic"), labels, validated!, id, ctx, runtime, ctxDocker, dataDir, baseEnv, mountPassthrough.mountAdditions, sidecars, tmpfsSpec, dotMount);
    // (#17) --remote-control against an image whose claude CLI predates
    // the flag: claude ignores unknown flags silently (exit 0), so the
    // session starts, looks healthy, RC never activates, no signal ever
    // surfaces. Warn loudly BEFORE starting the container. Interactive-
    // only (bash-parity — programmatic `-p` doesn't use RC). Non-fatal:
    // everything else works, so we continue after the warning.
    if (hasRemoteControlFlag(args)) {
      await warnIfRemoteControlBelowFloor(docker, ctxDocker, this.imageName, ctx.stderr);
    }
    return await this.runInteractive(cnameBase, labels, args, id, ctx, runtime, ctxDocker, dataDir, baseEnv, mountPassthrough.mountAdditions, sidecars, tmpfsSpec, dotMount);
  }

  private async runInteractive(
    cname: string, labels: RunLabels, args: readonly string[], id: string, ctx: Context, runtime: ContainerRuntime,
    ctxDocker: string, dataDir: string, baseEnv: RunArgs["env"],
    extraMounts: readonly RunArgs["mounts"][number][], sidecars: SidecarWriter,
    tmpfs: readonly string[], dotMount?: string,
  ): Promise<number> {
    // Extra interactive args go through the sidecar (entrypoint reads
    // them; `docker start -ai` can't take new argv).
    const extraArgs = args.filter((a) => a !== "--update" && a !== "--no-continue");
    if (extraArgs.length > 0) {
      await sidecars.writeOneRole("interactive-args", "", shellQuote(extraArgs) + "\n");
    }

    const existing = await runtime.psFilter(ctxDocker, cname);
    if (existing !== undefined) {
      ctx.stderr.write(`🔄 attaching to container ${cname}\n`);
      return await runtime.startAttached(ctxDocker, cname);
    }
    ctx.stderr.write(`🔧 starting container ${cname}\n`);
    const runArgs = this.buildRunArgs(ctxDocker, cname, labels, ctx, "interactive", [], dataDir, baseEnv, extraMounts, tmpfs, id, dotMount);
    return await runtime.runInteractive(runArgs);
  }

  private async runProgrammatic(
    cname: string, labels: RunLabels, validated: ReturnType<typeof validateProgArgs>, id: string, ctx: Context, runtime: ContainerRuntime,
    ctxDocker: string, dataDir: string, baseEnv: RunArgs["env"],
    extraMounts: readonly RunArgs["mounts"][number][], sidecars: SidecarWriter,
    tmpfs: readonly string[], dotMount?: string,
  ): Promise<number> {
    const existing = await runtime.psFilter(ctxDocker, cname);
    if (existing !== undefined) {
      await sidecars.writeOneRole("args", "_prog", shellQuote(validated.claudeArgs) + "\n");
      ctx.stderr.write(`🔄 attaching to container ${cname} (-p mode)\n`);
      return await runtime.startAttached(ctxDocker, cname);
    }
    // baseRunArgs already sets DRIDOCK_CONTAINER_NAME to `cname` (the
    // role's actual name), so no per-role override is needed. Bash's
    // duplicate `-e` at :3288 is a leftover from DOCKER_ARGS using
    // the INTERACTIVE name (:2817) — TS avoids that by computing cname
    // per-invocation.
    ctx.stderr.write(`🔧 starting container ${cname} (-p mode)\n`);
    const runArgs = this.buildRunArgs(ctxDocker, cname, labels, ctx, "attached", validated.claudeArgs, dataDir, baseEnv, extraMounts, tmpfs, id, dotMount);
    return await runtime.runInteractive(runArgs);
  }

  private buildRunArgs(
    ctxDocker: string, cname: string, labels: RunLabels, ctx: Context, mode: RunArgs["mode"],
    cmd: readonly string[], dataDir: string, baseEnv: RunArgs["env"],
    extraMounts: readonly RunArgs["mounts"][number][], tmpfs: readonly string[],
    id: string, dotMount?: string,
  ): RunArgs {
    const root = labels.find((l) => l.key === WORKSPACE_LABEL)!.value;
    return {
      context: ctxDocker,
      containerName: cname,
      image: this.imageName,
      network: "host",
      mounts: [
        // SSH source (DRIDOCK_SSH_DIR override). The ~/.ssh/claudebox default PATH
        // is deliberately unchanged in 5.0 — moving it would make users relocate
        // their keys, which is a different migration from dropping env tiers.
        { host: ctx.env.raw()["DRIDOCK_SSH_DIR"] ?? `${ctx.home}/.ssh/claudebox`, container: "/home/claude/.ssh" },
        // #80 phase 2: when the image is new enough, mount the whole per-project
        // dot dir over $HOME so agent-written dotfiles survive a recreate, with
        // .claude folded inside it. Otherwise fall back to the pre-phase-2
        // shape — mounting over an old image's $HOME shadows the baked CLI and
        // the container will not start.
        ...(dotMount
          ? [{ host: dotMount, container: "/home/claude" }]
          : [{ host: dataDir, container: "/home/claude/.claude" }]),
        // The workspace at its own host path (DooD). `root`, not cwd: the
        // guard upstream proved them equal, but this line is what depends on it.
        { host: root, container: root },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
        // Framework-bugs + consult — always mounted (empty dirs are fine)
        { host: `${(ctx.env.raw()["XDG_CONFIG_HOME"] ?? `${ctx.home}/.config`)}/dridock/framework-bugs`, container: "/home/claude/framework-bugs" },
        { host: `${(ctx.env.raw()["XDG_CONFIG_HOME"] ?? `${ctx.home}/.config`)}/dridock/consult`, container: "/home/claude/framework-consult" },
        // Extra mounts from DRIDOCK_MOUNT_* passthrough
        ...extraMounts,
      ],
      env: [
        { key: "DRIDOCK_CONTAINER_NAME", value: cname },   // matches wrapper.sh:2817 — set on all roles
        ...baseEnv,
      ],
      mode,
      cmd,
      publishPorts: [],
      tmpfs: tmpfs.length > 0 ? tmpfs : undefined,
      // Exclusions exist only when the $HOME bind is actually in place —
      // without it there is nothing to shadow, and creating a per-project
      // volume set nothing reads would just be orphans waiting to happen.
      volumes: dotMount !== undefined ? dotExclusionVolumes(id) : undefined,
      // #123: identity declared on the container, so adoption reads it instead
      // of inferring the workspace from (unordered) mounts.
      labels,
    };
  }
}

/**
 * Single-quote shell-escape a list of args into one line suitable for
 * `bash -c` re-evaluation. The entrypoint's args-file reader does `cat
 * "$ARGS_FILE"` then splits on IFS, so each arg must be safely
 * re-tokenized as one word. Matches bash's `printf %q ` semantics.
 */
export function shellQuote(args: readonly string[]): string {
  return args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
}

/** Ports wrapper.sh's DRIDOCK_TMPFS_TMP resolution (:2882-2883). */
function resolveTmpfs(env: Record<string, string | undefined>): readonly string[] {
  const raw = env["DRIDOCK_TMPFS_TMP"];
  if (raw === undefined || raw === "") return [];
  const size = raw === "1" || raw === "true" || raw === "yes" || raw === "on" ? "2g" : raw;
  return [`/tmp:size=${size},exec,mode=1777`];
}

/**
 * True when the argv contains the `--remote-control` flag (or the `--rc`
 * short form), including the `--flag=value` shape. Exported for tests.
 *
 * The exact-match on `--remote-control` (not a `startsWith`) is
 * deliberate — old CLIs carry a `--remote-control-session-name-prefix`
 * option that must NOT trigger this guard. Same reason bash pads with
 * spaces at wrapper.sh:3351.
 */
export function hasRemoteControlFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--remote-control" || arg === "--rc") return true;
    if (arg.startsWith("--remote-control=") || arg.startsWith("--rc=")) return true;
  }
  return false;
}

/**
 * The #17 guard body — queries the project image's baked claude CLI
 * version and emits a warning if it's below the RC floor. Returns
 * void because bash continues after warning (RC just won't activate;
 * everything else works). Exported for direct unit tests.
 */
export async function warnIfRemoteControlBelowFloor(
  docker: import("../../infra/Docker.ts").Docker,
  ctxDocker: string,
  imageName: string,
  stderr: import("../Context.ts").TextWriter,
): Promise<void> {
  const cliVersion = await docker.imageClaudeCliVersion(ctxDocker, imageName);
  // "unavailable" (image absent / docker call failed) — say nothing;
  // VmEnsure would already have failed loudly if this was actionable.
  // "unstamped" — same silence for the same reason.
  if (cliVersion === IMAGE_UNAVAILABLE || cliVersion === IMAGE_UNSTAMPED || cliVersion === "") return;
  const observed = Version.parseLoose(cliVersion);
  const floor = Version.parseLoose(CLAUDE_CLI_REMOTE_CONTROL_FLOOR);
  if (observed.compareTo(floor) !== "lt") return;
  stderr.write(`⚠️  --remote-control: this project's image ships Claude Code ${cliVersion}, which has no\n`);
  stderr.write(`    --remote-control flag (needs >= ${CLAUDE_CLI_REMOTE_CONTROL_FLOOR}). claude IGNORES unknown flags\n`);
  stderr.write(`    silently, so the session will start and Remote Control just won't activate.\n`);
  stderr.write(`    The CLI is baked into the image and can't self-update. Fix:\n`);
  stderr.write(`      ${makeTargetFor(imageName)}     # bump Dockerfile ARG CLAUDE_VERSION first if it's still old\n`);
  stderr.write(`    Continuing anyway — everything except Remote Control works normally.\n`);
}

type RunLabels = readonly { readonly key: string; readonly value: string }[];

// Injectable deps for tests.
export interface StartDeps {
  readonly colima: Colima;
  readonly docker: Docker;
  readonly runtime: ContainerRuntime;
  readonly git: GitToplevel;
  readonly hostGit: HostGit;
  readonly probe: ProcessProbe;
  readonly keepAwake: KeepAwake;
}

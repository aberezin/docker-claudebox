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
import type { HostGit } from "../../infra/HostGit.ts";
import { RealHostGit } from "../../infra/HostGit.ts";
import type { ProcessProbe } from "../../infra/ProcessProbe.ts";
import { RealProcessProbe } from "../../infra/ProcessProbe.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { containerName } from "../../services/ContainerName.ts";
import { guardWorkspace } from "../../services/WorkspaceGuard.ts";
import { validateProgArgs } from "../../services/ProgArgValidator.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import { VmEnsureService } from "../../services/VmEnsureService.ts";
import { ImageEnsureService } from "../../services/ImageEnsureService.ts";
import { ContainerRefresher } from "../../services/ContainerRefresher.ts";
import { SidecarWriter } from "../../services/SidecarWriter.ts";
import { AuthSecretsProvisioner } from "../../services/AuthSecretsProvisioner.ts";
import { collectEnvPassthrough, collectMountPassthrough } from "../../services/EnvMountPassthrough.ts";
import { BridgeStateReader } from "../../services/BridgeStateReader.ts";
import { xdgRoot } from "../../domain/paths.ts";
import { CLAUDE_CLI_REMOTE_CONTROL_FLOOR } from "../../domain/dridockVersion.ts";
import { Version } from "../../domain/Version.ts";
import { IMAGE_UNAVAILABLE, IMAGE_UNSTAMPED } from "../../infra/Docker.ts";

/**
 * `dridock start` — the main launch verb. Full port; no bash fallback.
 *
 * Composes:
 *   - guards: workspace (not-in-dotdir), projectId presence
 *   - `-p` arg validation BEFORE any side effect (allowlist)
 *   - auto-migrate `.claudebox` → `.dridock` on first run (via Migrate)
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

  constructor(
    private readonly imageName = "dridock:latest",
    private readonly deps: Partial<StartDeps> = {},
  ) {}

  async run(args: string[], ctx: Context): Promise<number> {
    // ── guards ─────────────────────────────────────────────────────────
    const guard = guardWorkspace(ctx.cwd, process.env, ctx.cwd);
    if (guard.kind === "in-dotdir") {
      ctx.stderr.write(`⚠️  You're inside a '${guard.dotName}' directory (${ctx.cwd}).\n`);
      ctx.stderr.write(`   claudebot would mount THIS dir as its workspace. You probably want:\n`);
      ctx.stderr.write(`     cd ${guard.suggestedCd} && ${ctx.binName} start\n`);
      ctx.stderr.write(`   (override with DRIDOCK_ALLOW_SUBDIR=1 if this is intentional)\n`);
      return 1;
    }

    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectCfg = new ProjectConfig(ctx.fs);
    const id = await projectCfg.projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — run '${ctx.binName} bootstrap' to scaffold ${project.dotName}/config.yml first.\n`);
      return 1;
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
      case "started":
        if (vmOutcome.warned) ctx.stderr.write(`⚠️  running near VM limit — starting anyway.\n`);
        break;
      case "already-running": break;
    }
    const vmIp = vmOutcome.kind === "started" || vmOutcome.kind === "already-running" ? vmOutcome.ip : "";

    // ── Resolve per-project data dir + sidecar writer ─────────────────
    const machine = new MachineConfig(ctx.fs, process.env, ctx.home);
    const dataDir = await machine.projectDataDir(id);
    await ctx.fs.mkdirRecursive(dataDir);
    const cnameBase = containerName(ctx.cwd); // matches wrapper.sh's `container_name`
    const sidecars = new SidecarWriter(ctx.fs, dataDir, cnameBase);

    // ── Provision every sidecar the entrypoint reads ──────────────────
    const auth = new AuthSecretsProvisioner(ctx.fs, sidecars, process.env, dataDir);
    await auth.writeAuthSidecars();
    await auth.writeSecretsSidecars(`${project.dotDir}/secrets.env`);
    const features = await projectCfg.features(project.configPath);
    await auth.writeFeaturesSidecar(features);

    // Env passthrough (DRIDOCK_ENV_*) → both -e + sidecar
    const envPassthrough = collectEnvPassthrough(process.env);
    await sidecars.writeAllRoles("env", envPassthrough.sidecarContent);

    // Mount passthrough (DRIDOCK_MOUNT_*) — no sidecar, mount-time only.
    const mountPassthrough = collectMountPassthrough(process.env);

    // CDP + host-agent sidecars — always written (empty when the bridge is down).
    const bridges = new BridgeStateReader(ctx.fs, process.env, ctx.home, probe);
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
    const ctxDocker = projectContext(id);
    const refresher = new ContainerRefresher(docker);
    await refresher.maybeRefresh(ctxDocker, cnameBase, this.imageName);
    if (isProg) await refresher.maybeRefresh(ctxDocker, containerName(ctx.cwd, "programmatic"), this.imageName);

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
    const xdg = await xdgRoot(ctx.fs, process.env, ctx.home);
    const fwbugsDir = `${xdg}/framework-bugs`;
    const consultDir = `${xdg}/consult`;
    await ctx.fs.mkdirRecursive(fwbugsDir);
    await ctx.fs.mkdirRecursive(consultDir);

    // ── DRIDOCK_GIT_NAME/EMAIL from host git config ──────────────────
    const gitName = await hostGit.configGet("user.name") ?? "";
    const gitEmail = await hostGit.configGet("user.email") ?? "";

    // ── Build the run env (all -e pairs) ─────────────────────────────
    const baseEnv: RunArgs["env"] = [
      { key: "DRIDOCK_GIT_NAME", value: gitName },
      { key: "DRIDOCK_GIT_EMAIL", value: gitEmail },
      { key: "DRIDOCK_WORKSPACE", value: ctx.cwd },
      { key: "DRIDOCK_PROJECT_ID", value: id },
      { key: "DRIDOCK_FRAMEWORK_BUGS_DIR", value: "/home/claude/framework-bugs" },
      { key: "DRIDOCK_CONSULT_DIR", value: "/home/claude/framework-consult" },
      ...(cdpUrl !== "" ? [{ key: "DRIDOCK_HOST_CDP_URL", value: cdpUrl }] : []),
      ...(vmIp !== "" ? [{ key: "DRIDOCK_VM_IP", value: vmIp }] : []),
      ...(hostname !== "" ? [{ key: "DRIDOCK_HOSTNAME", value: hostname }] : []),
      ...(process.env["DEBUG"] === "true" ? [{ key: "DEBUG", value: "true" }] : []),
      ...(process.env["DRIDOCK_DEFAULT_PLUGINS"] !== undefined
        ? [{ key: "DRIDOCK_DEFAULT_PLUGINS", value: process.env["DRIDOCK_DEFAULT_PLUGINS"] }] : []),
      ...envPassthrough.envAdditions,
    ];
    // tmpfs opt-in
    const tmpfsSpec = resolveTmpfs(process.env);

    // ── mode dispatch ─────────────────────────────────────────────────
    if (isProg) return await this.runProgrammatic(validated!, id, ctx, runtime, ctxDocker, dataDir, baseEnv, mountPassthrough.mountAdditions, sidecars, tmpfsSpec);
    // (#17) --remote-control against an image whose claude CLI predates
    // the flag: claude ignores unknown flags silently (exit 0), so the
    // session starts, looks healthy, RC never activates, no signal ever
    // surfaces. Warn loudly BEFORE starting the container. Interactive-
    // only (bash-parity — programmatic `-p` doesn't use RC). Non-fatal:
    // everything else works, so we continue after the warning.
    if (hasRemoteControlFlag(args)) {
      await warnIfRemoteControlBelowFloor(docker, ctxDocker, this.imageName, ctx.stderr);
    }
    return await this.runInteractive(args, id, ctx, runtime, ctxDocker, dataDir, baseEnv, mountPassthrough.mountAdditions, sidecars, tmpfsSpec);
  }

  private async runInteractive(
    args: readonly string[], id: string, ctx: Context, runtime: ContainerRuntime,
    ctxDocker: string, dataDir: string, baseEnv: RunArgs["env"],
    extraMounts: readonly RunArgs["mounts"][number][], sidecars: SidecarWriter,
    tmpfs: readonly string[],
  ): Promise<number> {
    const cname = containerName(ctx.cwd);
    // Extra interactive args go through the sidecar (entrypoint reads
    // them; `docker start -ai` can't take new argv).
    const extraArgs = args.filter((a) => a !== "--update" && a !== "--no-continue");
    if (extraArgs.length > 0) {
      await sidecars.writeOneRole("interactive-args", "", shellQuote(extraArgs) + "\n");
    }

    const existing = await runtime.psFilter(ctxDocker, cname);
    if (existing !== undefined) return await runtime.startAttached(ctxDocker, cname);
    const runArgs = this.buildRunArgs(ctxDocker, cname, id, ctx, "interactive", [], dataDir, baseEnv, extraMounts, tmpfs);
    return await runtime.runInteractive(runArgs);
  }

  private async runProgrammatic(
    validated: ReturnType<typeof validateProgArgs>, id: string, ctx: Context, runtime: ContainerRuntime,
    ctxDocker: string, dataDir: string, baseEnv: RunArgs["env"],
    extraMounts: readonly RunArgs["mounts"][number][], sidecars: SidecarWriter,
    tmpfs: readonly string[],
  ): Promise<number> {
    const cname = containerName(ctx.cwd, "programmatic");
    const existing = await runtime.psFilter(ctxDocker, cname);
    if (existing !== undefined) {
      await sidecars.writeOneRole("args", "_prog", shellQuote(validated.claudeArgs) + "\n");
      return await runtime.startAttached(ctxDocker, cname);
    }
    // baseRunArgs already sets DRIDOCK_CONTAINER_NAME to `cname` (the
    // role's actual name), so no per-role override is needed. Bash's
    // duplicate `-e` at :3288 is a leftover from DOCKER_ARGS using
    // the INTERACTIVE name (:2817) — TS avoids that by computing cname
    // per-invocation.
    const runArgs = this.buildRunArgs(ctxDocker, cname, id, ctx, "attached", validated.claudeArgs, dataDir, baseEnv, extraMounts, tmpfs);
    return await runtime.runInteractive(runArgs);
  }

  private buildRunArgs(
    ctxDocker: string, cname: string, id: string, ctx: Context, mode: RunArgs["mode"],
    cmd: readonly string[], dataDir: string, baseEnv: RunArgs["env"],
    extraMounts: readonly RunArgs["mounts"][number][], tmpfs: readonly string[],
  ): RunArgs {
    void id;
    return {
      context: ctxDocker,
      containerName: cname,
      image: this.imageName,
      network: "host",
      mounts: [
        // SSH source (DRIDOCK_SSH_DIR / legacy CLAUDEBOX_SSH_DIR override)
        { host: process.env["DRIDOCK_SSH_DIR"] ?? process.env["CLAUDEBOX_SSH_DIR"] ?? `${ctx.home}/.ssh/claudebox`, container: "/home/claude/.ssh" },
        // Per-project data dir — NOT the host global ~/.claude
        { host: dataDir, container: "/home/claude/.claude" },
        { host: ctx.cwd, container: ctx.cwd },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
        // Framework-bugs + consult — always mounted (empty dirs are fine)
        { host: `${(process.env["XDG_CONFIG_HOME"] ?? `${ctx.home}/.config`)}/dridock/framework-bugs`, container: "/home/claude/framework-bugs" },
        { host: `${(process.env["XDG_CONFIG_HOME"] ?? `${ctx.home}/.config`)}/dridock/consult`, container: "/home/claude/framework-consult" },
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
  const raw = env["DRIDOCK_TMPFS_TMP"] ?? env["CLAUDEBOX_TMPFS_TMP"] ?? env["CLAUDE_TMPFS_TMP"];
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
  stderr.write(`      make build     # bump Dockerfile ARG CLAUDE_VERSION first if it's still old\n`);
  stderr.write(`    Continuing anyway — everything except Remote Control works normally.\n`);
}

// Injectable deps for tests.
export interface StartDeps {
  readonly colima: Colima;
  readonly docker: Docker;
  readonly runtime: ContainerRuntime;
  readonly git: GitToplevel;
  readonly hostGit: HostGit;
  readonly probe: ProcessProbe;
}

import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { ContainerRuntime, RunArgs } from "../../infra/ContainerRuntime.ts";
import { RealContainerRuntime } from "../../infra/ContainerRuntime.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, projectContext, projectProfile } from "../../infra/Docker.ts";
import { IMAGE_UNAVAILABLE } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { containerName } from "../../services/ContainerName.ts";
import { guardWorkspace } from "../../services/WorkspaceGuard.ts";
import { validateProgArgs } from "../../services/ProgArgValidator.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock start` — the main launch verb. Phase 4 MVP: assumes VM is up
 * and image is built. On a cold cluster (VM stopped OR image absent) it
 * fails loudly with the same shape of advice as bash (audit rule: no
 * silent "silently does something surprising"). The full VM-ensure
 * orchestration (`colima start` with per-project cpu/mem/disk, reseed
 * on version drift, entrypoint bootstrap) is Phase 4b — that's the
 * biggest single chunk in the wrapper and needs its own commit for
 * proper testing.
 *
 * Two modes:
 *   1. Interactive (no -p) — `docker run -it` (or `docker start -ai` if
 *      a container for this workspace already exists).
 *   2. Programmatic (-p) — runs through ProgArgValidator first (the
 *      allowlist that closed #17/#31/#37), then a detached `_prog`
 *      container.
 */
export class StartCommand implements Command {
  readonly verb = "start" as const;

  constructor(
    private readonly imageName = "dridock:latest",
    private readonly colimaOverride?: Colima,
    private readonly runtimeOverride?: ContainerRuntime,
    private readonly dockerOverride?: Docker,
    private readonly gitOverride?: GitToplevel,
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

    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — run '${ctx.binName} bootstrap' (or the bash wrapper) to scaffold ${project.dotName}/config.yml first.\n`);
      return 1;
    }

    // ── mode detect + programmatic validation ─────────────────────────
    // Order matters: validate -p args BEFORE the VM/image ensure. The
    // whole point of moving the allowlist out of bash was to reject bad
    // flags (unknown, invalid --effort, missing value) BEFORE any side
    // effect — matching wrapper.sh:3150 which rejects at parse time,
    // long before any docker call. Doing the VM/image checks first (as
    // an earlier version did) let those checks preempt the validator when
    // the VM was down, silently converting a rejectable arg error into
    // a "use the bash wrapper" stub — Arfy caught this in #38 verify.
    const isProg = args.some((a) => a === "-p" || a === "--print");
    let validated: ReturnType<typeof validateProgArgs> | undefined;
    if (isProg) {
      // Throws DridockError rc 1 on any deviation; the CLI wrapper
      // catches + prints. This runs BEFORE colima/docker touches.
      validated = validateProgArgs(args);
    }

    const colima = this.colimaOverride ?? new RealColima();
    const runtime = this.runtimeOverride ?? new RealContainerRuntime();
    const docker = this.dockerOverride ?? new RealDocker();
    const profile = projectProfile(id);
    const context = projectContext(id);

    // ── VM ensure — MVP: fail loudly if the VM isn't up ────────────────
    if (!(await colima.isRunning(profile))) {
      ctx.stderr.write(`VM ${profile} is not running.\n`);
      ctx.stderr.write(`dridock-ts (Phase 4 MVP): VM boot is Phase 4b — use the bash wrapper to cold-start.\n`);
      return 2;
    }

    // ── Image ensure — MVP: fail loudly if absent ───────────────────────
    const imgVersion = await docker.imageVersion(context, this.imageName);
    if (imgVersion === IMAGE_UNAVAILABLE) {
      ctx.stderr.write(`image ${this.imageName} not present in VM ${profile}.\n`);
      ctx.stderr.write(`dridock-ts (Phase 4 MVP): image reseed is Phase 4b — use the bash wrapper.\n`);
      return 2;
    }

    // ── mode dispatch ─────────────────────────────────────────────────
    if (isProg) return await this.runProgrammaticValidated(validated!, id, ctx, runtime, context);
    return await this.runInteractive(args, id, ctx, runtime, context);
  }

  private async runInteractive(args: readonly string[], id: string, ctx: Context, runtime: ContainerRuntime, context: string): Promise<number> {
    void id;
    const cname = containerName(ctx.cwd);
    const existing = await runtime.psFilter(context, cname);
    if (existing !== undefined && /^Up /.test(existing.status)) {
      // Container is already running — attach via `docker start -ai`.
      // (bash uses `docker attach`; -ai does the same thing for a running one.)
      return await runtime.startAttached(context, cname);
    }
    if (existing !== undefined) {
      // Stopped/exited container — reattach.
      return await runtime.startAttached(context, cname);
    }

    // Fresh run. Assemble the minimum-viable docker run.
    const runArgs: RunArgs = {
      context,
      containerName: cname,
      image: this.imageName,
      mounts: [
        { host: ctx.cwd, container: ctx.cwd },
        { host: `${ctx.home}/.claude`, container: "/home/claude/.claude" },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
      ],
      env: [],
      workdir: ctx.cwd,
      network: "cb-net",
      mode: "interactive",
      cmd: ["claude", "--dangerously-skip-permissions", ...args],
      publishPorts: [],
    };
    return await runtime.runInteractive(runArgs);
  }

  private async runProgrammaticValidated(validated: ReturnType<typeof validateProgArgs>, id: string, ctx: Context, runtime: ContainerRuntime, context: string): Promise<number> {
    void id;
    if (validated.wantsUpdate) {
      ctx.stderr.write(`dridock-ts (Phase 4b): --update is Phase 4b — use the bash wrapper for the update path.\n`);
      return 2;
    }

    const cname = containerName(ctx.cwd, "programmatic");
    const runArgs: RunArgs = {
      context,
      containerName: cname,
      image: this.imageName,
      mounts: [
        { host: ctx.cwd, container: ctx.cwd },
        { host: `${ctx.home}/.claude`, container: "/home/claude/.claude" },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
      ],
      env: [{ key: "DRIDOCK_CONTAINER_NAME", value: cname }],
      workdir: ctx.cwd,
      network: "cb-net",
      // Foreground-attached, NO TTY (matches wrapper.sh:3288). Prog mode
      // must work headless — scripts, CI, `dridock -p '…' | jq`. `-it`
      // fails hard the moment stdin isn't a real terminal: `cannot attach
      // stdin to a TTY-enabled container`. Arfy #38 part 3 caught the
      // earlier "interactive" MVP shortcut here.
      mode: "attached",
      cmd: ["claude", "--dangerously-skip-permissions", ...validated.claudeArgs],
      publishPorts: [],
    };
    return await runtime.runInteractive(runArgs);
  }
}

// Re-export for tests that need to build DridockError expectations.
export { DridockError };

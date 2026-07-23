import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
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
 * on version drift, entrypoint bootstrap) is Phase 4b.
 *
 * Two modes:
 *   1. Interactive (no -p) — `docker run -it` (or `docker start -ai` if
 *      a container for this workspace already exists).
 *   2. Programmatic (-p) — runs through ProgArgValidator first (the
 *      allowlist that closed #17/#31/#37), then a foreground-attached
 *      `_prog` container (bash-parity for wrapper.sh:3288 — no -it,
 *      no -d, works headless in scripts / CI / pipes).
 *
 * Argv-parity note (Arfy #38 part 4): DOCKER_ARGS in wrapper.sh:2812 is
 * the source of truth for the run shape. The essential subset ported
 * here is:
 *   --network host
 *   -e DRIDOCK_WORKSPACE=<pwd>
 *   -e DRIDOCK_PROJECT_ID=<id>
 *   -e DRIDOCK_CONTAINER_NAME=<container_name>
 *   -v <ssh>:/home/claude/.ssh
 *   -v <~/.claude>:/home/claude/.claude
 *   -v <pwd>:<pwd>
 *   -v /var/run/docker.sock:/var/run/docker.sock
 * Deferred to Phase 4b (opt-in extras / framework-dev): CDP-bridge URL,
 * host-agent URL/token, framework-bugs mount, consult mount, tmpfs /tmp,
 * DRIDOCK_ENV_ passthrough, DEBUG passthrough, DRIDOCK_GIT_NAME + EMAIL,
 * RC/no-continue sidecars. All absent-but-optional in a normal user run
 * of -p; adding
 * them is mechanical when Phase 4b lands. NOT a silent skip — this
 * comment IS the visible signal.
 *
 * Container reuse: matches wrapper.sh:3281 for -p (existing → write
 * args sidecar + `docker start -a`; missing → `docker run --name`) and
 * the interactive path (existing → `docker start -ai`; missing →
 * `docker run -it`).
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
    // Validate -p args BEFORE the VM/image ensure — the whole point of
    // the allowlist is to reject bad flags with no side effect.
    const isProg = args.some((a) => a === "-p" || a === "--print");
    let validated: ReturnType<typeof validateProgArgs> | undefined;
    if (isProg) validated = validateProgArgs(args);

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

  /**
   * Interactive path. Reuse container if it exists; otherwise fresh run.
   * The container's argv is empty — the entrypoint pulls extra args from
   * a sidecar (`~/.claude/.<container>-interactive-args`) at
   * wrapper.sh's entrypoint.sh:1105.
   */
  private async runInteractive(args: readonly string[], id: string, ctx: Context, runtime: ContainerRuntime, context: string): Promise<number> {
    const cname = containerName(ctx.cwd);

    // Write extra interactive args to the sidecar the entrypoint reads.
    // Only when args non-empty — matches wrapper.sh:3311 shape.
    if (args.length > 0) {
      const sidecarPath = `${ctx.home}/.claude/.${cname}-interactive-args`;
      await ctx.fs.writeText(sidecarPath, shellQuote(args) + "\n", { mode: 0o600 });
    }

    const existing = await runtime.psFilter(context, cname);
    if (existing !== undefined) {
      // Reuse: docker start -ai reattaches (works for both running and stopped).
      return await runtime.startAttached(context, cname);
    }
    // Fresh run.
    const runArgs = this.baseRunArgs(context, cname, id, ctx, "interactive", []);
    return await runtime.runInteractive(runArgs);
  }

  /**
   * Programmatic path. wrapper.sh:3281 shape:
   *   - Container missing → `docker run --name … [DOCKER_ARGS] <image> <PASS_ARGS>`
   *   - Container present → write `.<name>-args` sidecar, `docker start -a`
   *
   * "attached" mode = no -it, no -d — foreground stdio inherited, no
   * TTY required. Works headless (scripts, CI, `… | jq`).
   */
  private async runProgrammaticValidated(validated: ReturnType<typeof validateProgArgs>, id: string, ctx: Context, runtime: ContainerRuntime, context: string): Promise<number> {
    if (validated.wantsUpdate) {
      ctx.stderr.write(`dridock-ts (Phase 4b): --update is Phase 4b — use the bash wrapper for the update path.\n`);
      return 2;
    }

    const cname = containerName(ctx.cwd, "programmatic");
    const existing = await runtime.psFilter(context, cname);
    if (existing !== undefined) {
      // Reuse path — args go via sidecar, then `docker start -a`. Matches
      // wrapper.sh:3293. Arfy #38 part 4 caught this: without reuse the
      // second `-p` invocation hits `name already in use`.
      const argsFile = `${ctx.home}/.claude/.${cname}-args`;
      await ctx.fs.writeText(argsFile, shellQuote(validated.claudeArgs) + "\n", { mode: 0o600 });
      return await runtime.startAttached(context, cname);
    }
    // Fresh run.
    const runArgs = this.baseRunArgs(context, cname, id, ctx, "attached", validated.claudeArgs);
    return await runtime.runInteractive(runArgs);
  }

  /**
   * Assemble the RunArgs the two paths share. Same mount + env skeleton
   * as wrapper.sh's DOCKER_ARGS (the essential subset — see class comment
   * for what's deferred to Phase 4b).
   */
  private baseRunArgs(context: string, cname: string, id: string, ctx: Context, mode: RunArgs["mode"], cmd: readonly string[]): RunArgs {
    return {
      context,
      containerName: cname,
      image: this.imageName,
      // --network host: the claudebot itself uses HOST networking, so it
      // sees the reachable-VM IP for CDP / published-port testing. `cb-net`
      // is the SIBLING-WORKLOAD network (attached to workloads the
      // claudebot spins up); the claudebot never sits on it. Arfy #38
      // part 4 caught the earlier `cb-net` hardcode as a hard rc-125
      // failure ("network cb-net not found") in fresh VMs.
      network: "host",
      mounts: [
        { host: `${ctx.home}/.ssh/claudebox`, container: "/home/claude/.ssh" },
        { host: `${ctx.home}/.claude`, container: "/home/claude/.claude" },
        { host: ctx.cwd, container: ctx.cwd },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
      ],
      env: [
        { key: "DRIDOCK_WORKSPACE", value: ctx.cwd },
        { key: "DRIDOCK_PROJECT_ID", value: id },
        { key: "DRIDOCK_CONTAINER_NAME", value: cname },
      ],
      mode,
      // Container argv is bare user args. The entrypoint prepends
      // `claude --dangerously-skip-permissions` — entrypoint.sh:1078
      // + 1141. Passing `claude …` here would double-prefix and fail.
      cmd,
      publishPorts: [],
    };
  }
}

/**
 * Single-quote shell-escape a list of args into one line suitable for
 * `bash -c` re-evaluation — same shape as bash's `printf '%q '`.
 * The entrypoint's args-file reader does `cat "$ARGS_FILE"` then splits
 * on IFS, so each arg must be safely re-tokenized as one word.
 */
export function shellQuote(args: readonly string[]): string {
  return args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
}

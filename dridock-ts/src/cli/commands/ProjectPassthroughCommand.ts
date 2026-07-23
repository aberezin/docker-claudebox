import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Verb } from "../../domain/Verbs.ts";
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

/**
 * `dridock mcp <sub>` / `dridock auth <sub>` — passthrough verbs that
 * mutate PROJECT-scoped persistent config (mcp servers list, OAuth
 * credentials). Ports wrapper.sh:3114 passthrough with the #39 fix:
 *   -e HOME=/home/claude -e CLAUDE_CONFIG_DIR=/home/claude/.claude
 *
 * Without those, `--entrypoint claude` bypasses entrypoint.sh, HOME
 * defaults to /root, and `claude mcp add` writes to /root/.claude.json
 * — outside the mounted /home/claude/.claude AND in a --rm container
 * (silent no-op). Same bug in bash today; TS ships the fix.
 *
 * NOT ThrowawayCommands (setup-token/doctor/-v): those are stateless
 * (no writes to a persistent path). mcp + auth WRITE — they need:
 *   - project docker context (not cb-infra)
 *   - project data-dir mounted at /home/claude/.claude
 *   - HOME + CLAUDE_CONFIG_DIR pointing INTO that mount
 *   - VM up (VmEnsure) + image present (ImageEnsure)
 *
 * mode = "attached" by default (works headless — mcp add/remove/list
 * don't need a TTY). Subclasses can override to "interactive" for
 * verbs that need one (auth login → browser OAuth callback).
 */
export abstract class ProjectPassthroughCommand implements Command {
  abstract readonly verb: Extract<Verb, "mcp" | "auth">;
  protected mode: "interactive" | "attached" = "attached";

  constructor(
    protected readonly imageName = "dridock:latest",
    protected readonly deps: Partial<ProjectPassthroughDeps> = {},
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectCfg = new ProjectConfig(ctx.fs);
    const id = await projectCfg.projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — '${ctx.binName} ${this.verb}' needs a project context (config.yml missing). Run '${ctx.binName} bootstrap' first.\n`);
      return 1;
    }

    // VM + image ensure — same as StartCommand
    const colima = this.deps.colima ?? new RealColima();
    const docker = this.deps.docker ?? new RealDocker();
    const runtime = this.deps.runtime ?? new RealContainerRuntime();
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

    // Resolve per-project data dir + build the throwaway RunArgs
    const machine = new MachineConfig(ctx.fs, process.env, ctx.home);
    const dataDir = await machine.projectDataDir(id);
    await ctx.fs.mkdirRecursive(dataDir);
    const cname = `${containerName(ctx.cwd)}_${this.verb}_${Date.now()}`;

    const ctxDocker = projectContext(id);
    void projectProfile;

    const runArgs: RunArgs = {
      context: ctxDocker,
      containerName: cname,
      image: this.imageName,
      // Throwaway shape — override entrypoint + auto-remove.
      entrypoint: "claude",
      removeAfter: true,
      mode: this.mode,
      network: "host",
      // #40 fix — `--entrypoint claude` bypasses entrypoint.sh's
      // `cd $WORKSPACE_DIR`, so without an explicit -w, claude runs
      // in the image's default WORKDIR (/workspace) and local-scope
      // `mcp add` keys under `.projects["/workspace"]` instead of the
      // real workspace path. Claudebot then reads the real-path key
      // and never sees the added server (bug caught in gammaray:
      // added → persisted at wrong project key → claudebot blind to it).
      // StartCommand doesn't need this because it uses the entrypoint
      // (which does the cd); passthrough must set -w explicitly.
      workdir: ctx.cwd,
      mounts: [
        // SSH — needed if `claude mcp` ever gits (some MCP add commands
        // clone; matches bash's DOCKER_ARGS.).
        { host: process.env["DRIDOCK_SSH_DIR"] ?? process.env["CLAUDEBOX_SSH_DIR"] ?? `${ctx.home}/.ssh/claudebox`, container: "/home/claude/.ssh" },
        // THE fix: mount the per-project data dir at /home/claude/.claude
        // so `claude` (running with HOME=/home/claude → below) reads +
        // WRITES its config INSIDE the mount → persists on the Mac.
        { host: dataDir, container: "/home/claude/.claude" },
        { host: ctx.cwd, container: ctx.cwd },
        { host: "/var/run/docker.sock", container: "/var/run/docker.sock" },
      ],
      env: [
        // The #39 fix — MUST be set because --entrypoint claude bypasses
        // entrypoint.sh which is the only thing that normally sets these.
        // Without them, claude looks up HOME → /root, writes .claude.json
        // to /root, which is outside the mount AND ephemeral with --rm.
        { key: "HOME", value: "/home/claude" },
        { key: "CLAUDE_CONFIG_DIR", value: "/home/claude/.claude" },
        // Standard env other commands set (workspace + project id) for
        // consistency; bash's DOCKER_ARGS includes them and cb-* helpers
        // inside the container read them.
        { key: "DRIDOCK_WORKSPACE", value: ctx.cwd },
        { key: "DRIDOCK_PROJECT_ID", value: id },
        // Auth token forward — claude subcommands need it for actual
        // model requests (mcp probably doesn't; auth login definitely
        // doesn't since it FETCHES a token). But it's harmless when
        // unused, and required if a `claude auth status` or `mcp` cmd
        // ever needs an API call. Empty when unset — no stray leak.
        ...(process.env["ANTHROPIC_API_KEY"] !== undefined ? [{ key: "ANTHROPIC_API_KEY", value: process.env["ANTHROPIC_API_KEY"] }] : []),
        ...(process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined ? [{ key: "CLAUDE_CODE_OAUTH_TOKEN", value: process.env["CLAUDE_CODE_OAUTH_TOKEN"] }] : []),
      ],
      cmd: [this.verb, ...args],
      publishPorts: [],
    };
    return await runtime.runInteractive(runArgs);
  }
}

export interface ProjectPassthroughDeps {
  readonly colima: Colima;
  readonly docker: Docker;
  readonly runtime: ContainerRuntime;
  readonly git: GitToplevel;
}

/** `dridock mcp <sub>` — MCP server config mutations. Persist via the
 *  #39 fix. Mode: attached — mcp add/remove/list work headless. */
export class McpCommand extends ProjectPassthroughCommand {
  readonly verb = "mcp" as const;
}

/** `dridock auth <sub>` — OAuth-flow credential mutations. Interactive
 *  because `auth login` opens a browser + waits for OAuth callback (needs
 *  a TTY to print the URL + block on user action). */
export class AuthCommand extends ProjectPassthroughCommand {
  readonly verb = "auth" as const;
  protected override mode: "interactive" | "attached" = "interactive";
}

import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";

/**
 * `dridock claude-dir` — print this project's host `.claude` data dir.
 * Read-only, no VM ensure, no config init — safe to pipe or eval from
 * host shell helpers. Ports wrapper.sh:2560-2573 (was a
 * BashDelegateCommand pre-2026-07-24; ported so bash-wrapper retirement
 * doesn't take it down with it).
 *
 * Resolution matches [[MachineConfig.projectDataDir]] — DRIDOCK_DATA_DIR
 * / CLAUDE_DATA_DIR override wins (used as-is, no /<id>/claude suffix);
 * otherwise `<machine data_root>/<projectId>/claude`.
 */
export class ClaudeDirCommand implements Command {
  readonly verb = "claude-dir" as const;

  constructor(private readonly gitOverride?: GitToplevel) {}

  async run(_args: readonly string[], ctx: Context): Promise<number> {
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      // Only the FALLBACK path needs a project — the env override branch
      // bypasses project detection entirely, matching bash's `if [ -n
      // "$_dd" ]; then printf …; else _cbid=… fi` shape.
      const envOverride = process.env["DRIDOCK_DATA_DIR"] ?? process.env["CLAUDE_DATA_DIR"];
      if (envOverride !== undefined && envOverride !== "") {
        ctx.stdout.write(`${envOverride}\n`);
        return 0;
      }
      ctx.stderr.write(`no dridock project here (${project.dotName}/config.yml missing)\n`);
      return 1;
    }
    const dataDir = await new MachineConfig(ctx.fs, process.env, ctx.home).projectDataDir(id);
    ctx.stdout.write(`${dataDir}\n`);
    return 0;
  }
}

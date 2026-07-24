import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";

/**
 * `dridock clear-session` — remove the resumable session state for $PWD.
 * Ports wrapper.sh:3038. Not project-scoped (session state is per-workspace,
 * not per-project VM). Idempotent when the dir doesn't exist.
 */
export class ClearSessionCommand implements Command {
  readonly verb = "clear-session" as const;

  async run(_args: readonly string[], ctx: Context): Promise<number> {
    // Bash uses CLAUDE_DIR/projects/<project-slug> where project-slug is
    // $PWD with slashes → hyphens. Ports that exactly. Note this uses
    // ~/.claude — the shared claudebot config dir on the HOST, NOT the
    // per-project data dir (per-project sessions are elsewhere).
    const slug = ctx.cwd.replaceAll("/", "-");
    const projectDir = `${ctx.home}/.claude/projects/${slug}`;
    if (!(await ctx.fs.isDirectory(projectDir))) {
      ctx.stdout.write(`no session found for ${ctx.cwd} (looked in ${projectDir})\n`);
      return 0;
    }
    await ctx.fs.removeDirRecursive(projectDir);
    ctx.stdout.write(`cleared session for ${ctx.cwd}\n`);
    return 0;
  }
}

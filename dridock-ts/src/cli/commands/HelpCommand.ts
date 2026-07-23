import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { VERBS, type Verb } from "../../domain/Verbs.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";

/**
 * `dridock help` — full help. Ports wrapper.sh:2229's help block.
 * Groups verbs by class for a scannable layout.
 */
export class HelpCommand implements Command {
  readonly verb = "help" as const;

  async run(_args: readonly string[], ctx: Context): Promise<number> {
    const bin = ctx.binName;
    ctx.stdout.write(`dridock ${DRIDOCK_TS_VERSION} — run Claude Code in a per-project Colima VM.\n\n`);
    ctx.stdout.write(`USAGE\n`);
    ctx.stdout.write(`  ${bin} start [claude args...]  start/attach the interactive claudebot for $PWD\n`);
    ctx.stdout.write(`  ${bin} start -p "<prompt>" ... one-shot programmatic run (JSON via --output-format)\n`);
    ctx.stdout.write(`  ${bin} <command>              a management command (below)\n`);
    ctx.stdout.write(`  ${bin}                        print version + start hint\n\n`);

    // Section headings mirror wrapper.sh's help layout.
    this.renderSection(ctx, "PROJECT", ["bootstrap", "info", "status", "features", "profiles", "ip", "net", "stop", "clear-session"]);
    this.renderSection(ctx, "VM / DISK", ["vm", "df", "down", "destroy"]);
    this.renderSection(ctx, "VERSION", ["version", "checkversion"]);
    this.renderSection(ctx, "OTHER", [
      "migrate", "completion", "browser-bridge", "host-agent", "harness",
      "framework-bugs", "consult", "setup-token", "doctor", "auth", "mcp", "report-bug",
    ]);

    ctx.stdout.write(`\nUSEFUL ENV\n`);
    ctx.stdout.write(`  DRIDOCK_MINIMAL=1             use the minimal image variant\n`);
    ctx.stdout.write(`  DRIDOCK_NO_API_KEY=1          never forward ANTHROPIC_API_KEY (use Claude subscription)\n`);
    ctx.stdout.write(`  DRIDOCK_NO_OAUTH_TOKEN=1      never forward CLAUDE_CODE_OAUTH_TOKEN\n`);
    ctx.stdout.write(`  DRIDOCK_ALLOW_SUBDIR=1        skip the '.dridock subdir' launch guard\n`);
    ctx.stdout.write(`  DRIDOCK_NO_AUTO_MIGRATE=1     skip the 3.0 auto-migration of a legacy .claudebox/ workspace\n`);
    ctx.stdout.write(`  DRIDOCK_ENV_FOO=bar           forward FOO=bar into the container\n`);
    ctx.stdout.write(`  DRIDOCK_MOUNT_SCRATCH=/path   extra volume mount into the container\n`);
    ctx.stdout.write(`  DRIDOCK_TMPFS_TMP=2g          RAM-back /tmp\n`);
    ctx.stdout.write(`  DRIDOCK_BASH_WRAPPER=/path/wrapper.sh   for the two bash-delegated verbs\n`);
    ctx.stdout.write(`  See docs/environment-variables.md for the full list.\n`);
    return 0;
  }

  private renderSection(ctx: Context, heading: string, verbs: readonly string[]): void {
    ctx.stdout.write(`\n${heading}\n`);
    for (const name of verbs) {
      const spec = VERBS[name as Verb] as { summary: string; subcommands?: readonly string[] } | undefined;
      if (spec === undefined) continue;
      const cmdCol = spec.subcommands !== undefined
        ? `${name} [${spec.subcommands.join("|")}]`
        : name;
      const COL_WIDTH = 40;
      const padded = cmdCol.length >= COL_WIDTH ? cmdCol + "  " : cmdCol.padEnd(COL_WIDTH);
      ctx.stdout.write(`  ${padded}${spec.summary}\n`);
    }
  }
}

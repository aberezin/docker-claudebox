import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext } from "../../infra/Docker.ts";

/**
 * TRULY-STATELESS passthrough verbs — run one `claude` subcommand in a
 * throwaway container against cb-infra (no project VM required, no
 * persistent state written). Just `setup-token` and `doctor` here now.
 *
 * `mcp` + `auth` USED to be in this file — they've been extracted to
 * `ProjectPassthroughCommand` because they mutate PROJECT-scoped
 * persistent config and need the project data-dir mount + HOME +
 * CLAUDE_CONFIG_DIR env fix. See #39.
 *
 * DELIBERATE DIVERGENCE from bash — bash cold-starts the current dir's
 * project VM to run doctor/setup-token; TS routes to cb-infra instead.
 * No project VM required to run `claude doctor`. Arfy #38 P4c pass 3
 * explicitly preferred this shape.
 */
abstract class ClaudePassthroughCommand implements Command {
  abstract readonly verb: "setup-token" | "doctor";
  constructor(
    protected readonly dockerOverride?: Docker,
    protected readonly imageName = "dridock:latest",
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const docker = this.dockerOverride ?? new RealDocker();
    const captured = await docker.runCapture(infraContext(), this.imageName, {
      entrypoint: "claude",
      args: [this.verb, ...args],
    });
    if (captured.stdout !== "") ctx.stdout.write(captured.stdout);
    return captured.rc;
  }
}

export class SetupTokenCommand extends ClaudePassthroughCommand {
  readonly verb = "setup-token" as const;
}
export class DoctorCommand extends ClaudePassthroughCommand {
  readonly verb = "doctor" as const;
}

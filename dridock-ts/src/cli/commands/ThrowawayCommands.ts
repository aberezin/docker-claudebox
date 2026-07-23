import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext } from "../../infra/Docker.ts";

/**
 * Passthrough verbs that spawn a throwaway container to run one `claude`
 * subcommand. Ports the `setup-token|-v|--version|doctor|auth|mcp|stop|
 * clear-session` allowlist at wrapper.sh:2769 (setup-token) + the top-
 * level shortcuts. Uses cb-infra as the docker context so a project VM
 * isn't required.
 *
 * All four run the same shape:
 *   docker --context colima-cb-infra run --rm --entrypoint claude
 *          dridock:latest <sub> <args...>
 *
 * Output goes directly to the user's stdout/stderr via runCapture (which
 * we could stream, but MVP captures + prints — that's still bash-parity
 * for the setup-token/doctor/auth/mcp shape).
 */
abstract class ClaudePassthroughCommand implements Command {
  abstract readonly verb: "setup-token" | "doctor" | "auth" | "mcp";
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
export class AuthCommand extends ClaudePassthroughCommand {
  readonly verb = "auth" as const;
}
export class McpCommand extends ClaudePassthroughCommand {
  readonly verb = "mcp" as const;
}

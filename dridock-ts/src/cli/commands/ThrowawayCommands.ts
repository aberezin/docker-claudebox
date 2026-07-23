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
 *
 * DELIBERATE DIVERGENCE from bash — cb-infra context, not the project VM.
 * Arfy #38 P4c pass 3 noted this: bash cold-starts the CURRENT DIR's
 * project VM to run these throwaway verbs (which also spuriously
 * cold-starts a VM for `dridock doctor` in a bare shell, and TTY-fails
 * on the throwaway container in a non-terminal). TS routes to cb-infra
 * instead: no project VM required to run `claude doctor`. Arfy prefers
 * TS's shape; keeping it. If a `-v/--version/doctor/mcp` invocation ever
 * legitimately needs the PROJECT image's baked claude (vs cb-infra's),
 * revisit — for now cb-infra's is identical (same image tag).
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

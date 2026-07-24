import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";

/**
 * `dridock version` — prints the wrapper's semver on a single line, exit 0.
 * Ports wrapper.sh's:
 *
 *     version)
 *         echo "dridock $DRIDOCK_VERSION"
 *         exit 0
 *         ;;
 */
export class VersionCommand implements Command {
  readonly verb = "version" as const;

  async run(_args: string[], ctx: Context): Promise<number> {
    ctx.stdout.write(`dridock ${DRIDOCK_TS_VERSION}\n`);
    return 0;
  }
}

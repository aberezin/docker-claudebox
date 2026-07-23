import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import { VmDiskUsageService } from "../../services/VmDiskUsageService.ts";

/**
 * `dridock df` — at-a-glance VM disk usage summary. Ports the top-level
 * `df` case (delegates to `vm usage` internally). Same output shape.
 */
export class DfCommand implements Command {
  readonly verb = "df" as const;

  constructor(private readonly colimaOverride?: Colima) {}

  async run(_args: readonly string[], ctx: Context): Promise<number> {
    const colima = this.colimaOverride ?? new RealColima();
    return await new VmDiskUsageService(colima).run(ctx);
  }
}

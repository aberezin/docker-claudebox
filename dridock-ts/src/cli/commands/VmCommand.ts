import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import { cbH } from "../../domain/units.ts";

/**
 * `dridock vm <sub>` — colima VM diagnostics. Ports wrapper.sh:2291
 * dispatch table.
 *
 * Subverbs:
 *   ls | list        — list cb-* project VMs (+ cb-infra status line)
 *   usage | df       — per-VM disk footprint (needs limactl on macOS)
 *   gc               — reclaim disk (limactl disk delete + docker prune + fstrim)
 *
 * `vm ls` is fully implemented here. `vm usage` and `vm gc` route to the
 * VmUsageService / VmGcService (separate files, macOS-specific).
 */
export class VmCommand implements Command {
  readonly verb = "vm" as const;

  constructor(private readonly colimaOverride?: Colima) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "ls";
    switch (sub) {
      case "ls": case "list": return await this.ls(ctx);
      case "usage": case "df": return await this.usage(ctx);
      case "gc": return await this.gc(ctx);
      case "-h": case "--help":
        ctx.stdout.write(`usage: ${ctx.binName} vm [ls|usage|gc]\n`);
        return 0;
      default:
        throw new DridockError(`vm: unknown sub-verb '${sub}' (allowed: ls, usage, gc)`);
    }
  }

  private async ls(ctx: Context): Promise<number> {
    const colima = this.colimaOverride ?? new RealColima();
    const vms = await colima.list();
    const project = vms.filter((v) => v.name.startsWith("cb-") && v.name !== "cb-infra");
    const infra = vms.find((v) => v.name === "cb-infra");

    if (project.length === 0) {
      ctx.stdout.write(`no dridock project VMs\n`);
    } else {
      // Column-align matching bash `column -t -s $'\t'` output
      const width = Math.max(7, ...project.map((v) => v.name.length));
      ctx.stdout.write(`PROFILE${" ".repeat(width - 7)}  STATUS\n`);
      for (const v of project.sort((a, b) => a.name.localeCompare(b.name))) {
        ctx.stdout.write(`${v.name.padEnd(width)}  ${v.status}\n`);
      }
    }
    if (infra !== undefined) {
      ctx.stdout.write(`infra (cb-infra): ${infra.status}\n`);
    }
    return 0;
  }

  /**
   * `vm usage` — per-VM disk footprint. Bash (:857) shells to `limactl
   * disk ls` + `du -sk` inside colima's LIMA_HOME. Portable minimum: use
   * `colima list --json`'s memory/disk fields (the provisioned MAX, not
   * on-disk actual) + limactl disk ls for orphan detection.
   *
   * Full port would need a `Limactl` adapter. TS delegates to a small
   * VmDiskUsageService (below).
   */
  private async usage(ctx: Context): Promise<number> {
    const { VmDiskUsageService } = await import("../../services/VmDiskUsageService.ts");
    const colima = this.colimaOverride ?? new RealColima();
    const svc = new VmDiskUsageService(colima);
    return await svc.run(ctx);
  }

  /**
   * `vm gc` — reclaim disk (limactl orphan prune + docker image/builder
   * prune per running VM + `colima ssh fstrim`). Bash at :905.
   */
  private async gc(ctx: Context): Promise<number> {
    const { VmGcService } = await import("../../services/VmGcService.ts");
    const colima = this.colimaOverride ?? new RealColima();
    const svc = new VmGcService(colima);
    return await svc.run(ctx);
  }
}

// Re-exports so tests don't have to import from ../../domain/units.
export { cbH };

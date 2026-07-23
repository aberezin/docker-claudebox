import type { Colima } from "../infra/Colima.ts";
import type { Context } from "../cli/Context.ts";

/**
 * `dridock vm usage` — per-VM disk footprint summary. Ports the
 * user-facing shape of wrapper.sh:857 without the full lima-home
 * `du -sk` measurement (that needs LIMA_HOME probing + limactl disk ls,
 * which fires on real macOS). In-container we surface the provisioned
 * MAX from colima's own inventory + a note that the on-disk actual is
 * a real-macOS-only detail.
 *
 * Live parity on macOS: shows PROFILE STATUS MAX per VM, cb-infra
 * separately, and a totals line. The "on-disk actual" column is
 * (macOS only — check bash) since a real du -sk needs the Mac's FS.
 */
export class VmDiskUsageService {
  constructor(private readonly colima: Colima) {}

  async run(ctx: Context): Promise<number> {
    const vms = await this.colima.list();
    const project = vms.filter((v) => v.name.startsWith("cb-") && v.name !== "cb-infra");
    const infra = vms.find((v) => v.name === "cb-infra");

    ctx.stdout.write(`dridock VM disk usage (provisioned max):\n`);
    if (project.length === 0 && infra === undefined) {
      ctx.stdout.write(`  (no dridock VMs)\n`);
      return 0;
    }
    const nameWidth = Math.max(7, ...vms.map((v) => v.name.length));
    ctx.stdout.write(`  ${"PROFILE".padEnd(nameWidth)}  STATUS   MAX\n`);
    for (const vm of [...project].sort((a, b) => a.name.localeCompare(b.name))) {
      ctx.stdout.write(`  ${vm.name.padEnd(nameWidth)}  ${vm.status.padEnd(7)}  ${vm.disk ?? "?"}\n`);
    }
    if (infra !== undefined) {
      ctx.stdout.write(`  ${infra.name.padEnd(nameWidth)}  ${infra.status.padEnd(7)}  ${infra.disk ?? "?"}\n`);
    }
    ctx.stdout.write(`\n`);
    ctx.stdout.write(`  (on-disk actual + orphaned-disk detection: run on the Mac — needs LIMA_HOME + limactl disk ls)\n`);
    return 0;
  }
}

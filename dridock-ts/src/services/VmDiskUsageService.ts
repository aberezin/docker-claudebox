import type { Colima } from "../infra/Colima.ts";
import { resolveLimaHome } from "../infra/Colima.ts";
import type { Limactl, LimaDisk } from "../infra/Limactl.ts";
import { RealLimactl } from "../infra/Limactl.ts";
import type { DiskProbe } from "../infra/DiskProbe.ts";
import { RealDiskProbe } from "../infra/DiskProbe.ts";
import type { FileSystem } from "../infra/FileSystem.ts";
import type { Context } from "../cli/Context.ts";
import { cbH } from "../domain/units.ts";

/**
 * `dridock vm usage` — per-VM disk footprint. Ports cb_vm_usage at
 * wrapper.sh:857 fully:
 *   - `limactl disk ls` for the provisioned MAX per disk
 *   - `du -sk` on `<LIMA_HOME>/_disks/<name>` + `<LIMA_HOME>/<name>` for
 *     the actual on-Mac footprint (VM disks are sparse — the MAX rarely
 *     reflects real usage)
 *   - Orphan detection: a disk whose profile isn't in `colima list --json`
 *     — keyed on NAME not IN-USE-BY (bash's safety comment at :864-866
 *     spells out why: IN-USE-BY is blank for STOPPED VMs, would misflag
 *     cb-infra's disk when infra is off)
 *   - Totals line grouping projects / cb-infra / default (human) / orphans
 *
 * Arfy #38 P4c B3 caught the previous stub — MAX column was `?`, no
 * on-disk-actual column at all.
 */
export class VmDiskUsageService {
  constructor(
    private readonly colima: Colima,
    private readonly deps: VmDiskUsageDeps = {},
  ) {}

  async run(ctx: Context): Promise<number> {
    const fs = this.deps.fs ?? ctx.fs;
    const limactl = this.deps.limactl ?? new RealLimactl();
    const disk = this.deps.diskProbe ?? new RealDiskProbe();
    const home = ctx.home;
    const env = this.deps.env ?? process.env;
    const limaHome = await resolveLimaHome(fs, env, home);
    if (limaHome === undefined) {
      // Fallback: no LIMA_HOME + no limactl. Print colima's inventory
      // MAX-only + note the on-disk-actual is Mac-only.
      return await this.runFallback(ctx);
    }

    const disks = await limactl.diskLs(limaHome);
    if (disks.length === 0) {
      // limactl reported nothing — still fall back to colima inventory
      return await this.runFallback(ctx);
    }
    const vms = await this.colima.list();
    const knownProfiles = new Set(vms.map((v) => v.name));

    interface Row { readonly name: string; readonly status: string; readonly onDisk: string; readonly max: string; readonly tag: string; readonly onDiskKb: number }
    const live: Row[] = [];
    const orph: Row[] = [];
    let projKb = 0, infraKb = 0, defKb = 0, orphKb = 0;

    for (const d of disks) {
      // Match bash: profile = name.stripPrefix("colima-"), or "default" when name === "colima"
      const profile = d.name === "colima" ? "default" : d.name.replace(/^colima-/, "");
      // du -sk on the disk file + the instance dir
      const dk = await disk.usageKb(`${limaHome}/_disks/${d.name}`);
      const ik = await disk.usageKb(`${limaHome}/${d.name}`);
      const totalKb = dk + ik;
      const onDisk = cbH(totalKb * 1024);
      if (!knownProfiles.has(profile) && profile !== "default") {
        orph.push({ name: d.name, status: "-", onDisk, max: d.max, tag: "", onDiskKb: totalKb });
        orphKb += totalKb;
      } else {
        const status = vms.find((v) => v.name === profile)?.status ?? "?";
        let tag = "";
        if (d.name === "colima") { defKb += totalKb; tag = " (human)"; }
        else if (d.name === "colima-cb-infra") infraKb += totalKb;
        else if (d.name.startsWith("colima-cb-")) projKb += totalKb;
        live.push({ name: `${profile}${tag}`, status, onDisk, max: d.max, tag, onDiskKb: totalKb });
      }
    }

    ctx.stdout.write(`dridock VM disk usage (actual on the Mac / provisioned max):\n`);
    if (live.length === 0) {
      ctx.stdout.write(`(no dridock VMs)\n`);
    } else {
      const nameWidth = Math.max(7, ...live.map((r) => r.name.length));
      const statusWidth = Math.max(6, ...live.map((r) => r.status.length));
      // ON-DISK width computed from actual values, matching bash's
      // `column -t` auto-width. Arfy #38 P4c pass 3 residual: was
      // padded fixed 8 → 1 space wider than bash for typical values.
      const onDiskWidth = Math.max(7, ...live.map((r) => r.onDisk.length));
      ctx.stdout.write(`${"PROFILE".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  ${"ON-DISK".padEnd(onDiskWidth)}  MAX\n`);
      // Arfy #38 P4c pass 2 B3 cosmetic: default (human) listed FIRST
      // to match bash cb_vm_usage output ordering. Sort with default
      // priority-first, then everything else alphabetically.
      const sorted = [...live].sort((a, b) => {
        const aDefault = a.name.startsWith("default");
        const bDefault = b.name.startsWith("default");
        if (aDefault && !bDefault) return -1;
        if (!aDefault && bDefault) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const r of sorted) {
        ctx.stdout.write(`${r.name.padEnd(nameWidth)}  ${r.status.padEnd(statusWidth)}  ${r.onDisk.padEnd(onDiskWidth)}  ${r.max}\n`);
      }
    }
    if (orph.length > 0) {
      ctx.stdout.write(`\norphaned disks — no VM owns these (reclaim with '${ctx.binName} vm gc'):\n`);
      const nameWidth = Math.max(4, ...orph.map((r) => r.name.length));
      const onDiskWidth = Math.max(7, ...orph.map((r) => r.onDisk.length));
      ctx.stdout.write(`${"DISK".padEnd(nameWidth)}  ${"ON-DISK".padEnd(onDiskWidth)}  MAX\n`);
      for (const r of orph.sort((a, b) => a.name.localeCompare(b.name))) {
        ctx.stdout.write(`${r.name.padEnd(nameWidth)}  ${r.onDisk.padEnd(onDiskWidth)}  ${r.max}\n`);
      }
    }
    ctx.stdout.write(`\ntotals — projects: ${cbH(projKb * 1024)}   cb-infra: ${cbH(infraKb * 1024)}   default(human): ${cbH(defKb * 1024)}   orphaned: ${cbH(orphKb * 1024)}\n`);
    return 0;
  }

  /** Fallback path: no limactl / no LIMA_HOME. Uses colima list --json's
   *  MAX field only + notes what's missing. */
  private async runFallback(ctx: Context): Promise<number> {
    const vms = await this.colima.list();
    const project = vms.filter((v) => v.name.startsWith("cb-") && v.name !== "cb-infra");
    const infra = vms.find((v) => v.name === "cb-infra");
    ctx.stdout.write(`dridock VM disk usage (provisioned max):\n`);
    if (project.length === 0 && infra === undefined) {
      ctx.stdout.write(`(no dridock VMs)\n`);
      return 0;
    }
    const nameWidth = Math.max(7, ...vms.map((v) => v.name.length));
    ctx.stdout.write(`${"PROFILE".padEnd(nameWidth)}  STATUS   MAX\n`);
    for (const vm of [...project].sort((a, b) => a.name.localeCompare(b.name))) {
      ctx.stdout.write(`${vm.name.padEnd(nameWidth)}  ${vm.status.padEnd(7)}  ${vm.disk ?? "?"}\n`);
    }
    if (infra !== undefined) {
      ctx.stdout.write(`${infra.name.padEnd(nameWidth)}  ${infra.status.padEnd(7)}  ${infra.disk ?? "?"}\n`);
    }
    ctx.stdout.write(`\n(on-disk actual + orphaned-disk detection require limactl + LIMA_HOME — install colima)\n`);
    return 0;
  }
}

export interface VmDiskUsageDeps {
  readonly limactl?: Limactl;
  readonly diskProbe?: DiskProbe;
  readonly fs?: FileSystem;
  readonly env?: Record<string, string | undefined>;
}

void ({} as LimaDisk); // avoid TS "declared but never used"

import type { Colima } from "../infra/Colima.ts";
import { resolveLimaHome } from "../infra/Colima.ts";
import type { Docker } from "../infra/Docker.ts";
import type { Limactl } from "../infra/Limactl.ts";
import type { DiskProbe } from "../infra/DiskProbe.ts";
import type { FileSystem } from "../infra/FileSystem.ts";
import { RealDocker } from "../infra/Docker.ts";
import { RealLimactl } from "../infra/Limactl.ts";
import { RealDiskProbe } from "../infra/DiskProbe.ts";
import { RealFileSystem } from "../infra/RealFileSystem.ts";
import type { Context } from "../cli/Context.ts";
import { cbH } from "../domain/units.ts";

/**
 * `dridock vm gc` — reclaim disk. Ports wrapper.sh:905. Three passes:
 *   1. limactl orphan detection + delete (cross-reference disks against
 *      known colima profiles; keys on NAME not IN-USE-BY so stopped VMs'
 *      disks aren't mistaken for orphans — matches bash's safety
 *      comment at :912).
 *   2. `docker image prune -f` + `docker builder prune -f` per running
 *      cb-* VM (the build cache is the real accumulator).
 *   3. `colima ssh -- sudo fstrim -av` on each running cb-* so freed
 *      blocks return to macOS.
 * Human's `default` VM deliberately left untouched.
 */
export class VmGcService {
  constructor(
    private readonly colima: Colima,
    private readonly docker: Docker = new RealDocker(),
    private readonly limactl: Limactl = new RealLimactl(),
    private readonly limaHomeOverride?: string,
    private readonly diskProbe: DiskProbe = new RealDiskProbe(),
    private readonly fs: FileSystem = new RealFileSystem(),
  ) {}

  async run(ctx: Context): Promise<number> {
    // Resolve LIMA_HOME up front so we can (a) hand it to limactl (b)
    // measure before/after usage for the reclaim summary. Falls back to
    // undefined if colima isn't installed — the summary is skipped.
    const limaHome = this.limaHomeOverride
      ?? (await resolveLimaHome(this.fs, process.env, process.env["HOME"] ?? "/"));
    // Arfy #38 P4c pass 3 residual: bash prints "reclaimed ~5.3G;
    // colima now uses 66.4G" — port via du -sk before/after LIMA_HOME.
    const beforeKb = limaHome !== undefined ? await this.diskProbe.usageKb(limaHome) : 0;

    ctx.stdout.write(`🧹 pruning orphaned lima disks (no owning colima profile)...\n`);
    const disks = await this.limactl.diskLs(limaHome ?? "");
    const knownProfiles = new Set(
      (await this.colima.list()).map((v) => v.name === "colima" ? "default" : v.name),
    );
    const orphans: string[] = [];
    for (const d of disks) {
      const profile = d.name === "colima" ? "default" : d.name.replace(/^colima-/, "");
      if (!knownProfiles.has(profile)) orphans.push(d.name);
    }
    if (orphans.length === 0) {
      ctx.stdout.write(`   (none)\n`);
    } else {
      for (const o of orphans) ctx.stdout.write(`   - ${o}\n`);
      const rc = limaHome !== undefined ? await this.limactl.diskDelete(limaHome, orphans) : 1;
      if (rc === 0) ctx.stdout.write(`   ✓ deleted ${orphans.length} orphaned disk(s)\n`);
      else ctx.stderr.write(`   ⚠ some orphaned disks could not be deleted\n`);
    }

    ctx.stdout.write(`🖼  pruning dangling images + BuildKit build cache in running dridock VMs...\n`);
    const runningProfiles = (await this.colima.list())
      .filter((v) => v.name.startsWith("cb-") && v.status === "Running")
      .map((v) => v.name);
    for (const p of runningProfiles) {
      const context = `colima-${p}`;
      const img = await this.docker.imagePrune(context);
      const builder = await this.docker.builderPrune(context);
      ctx.stdout.write(`   - ${p.padEnd(14)} images ${img.reclaimed} · build cache ${builder.reclaimed}\n`);
    }

    ctx.stdout.write(`🧻 fstrim on running dridock VMs (return freed blocks to macOS)...\n`);
    let trimmed = 0;
    for (const p of runningProfiles) {
      ctx.stdout.write(`   - ${p} ... `);
      const rc = await this.colima.ssh(p, ["sudo", "fstrim", "-av"]);
      if (rc === 0) { ctx.stdout.write(`ok\n`); trimmed++; }
      else ctx.stdout.write(`skipped (unreachable?)\n`);
    }
    if (trimmed === 0) ctx.stdout.write(`   (no running dridock VMs)\n`);

    // Arfy #38 P4c pass 3 residual: reclaim summary. Bash prints
    // "reclaimed ~5.3G; colima now uses 66.4G" — measure before/after
    // du -sk on LIMA_HOME. Skipped silently when LIMA_HOME isn't
    // resolvable (non-macOS / no colima install).
    if (limaHome !== undefined) {
      const afterKb = await this.diskProbe.usageKb(limaHome);
      const freedKb = Math.max(0, beforeKb - afterKb);
      ctx.stdout.write(`\n✅ vm gc done — reclaimed ~${cbH(freedKb * 1024)}; colima now uses ${cbH(afterKb * 1024)}.\n`);
    } else {
      ctx.stdout.write(`\n✅ vm gc done.\n`);
    }
    ctx.stdout.write(`   (default/human VM left untouched — trim it yourself: colima ssh -p default -- sudo fstrim -av)\n`);
    return 0;
  }
}

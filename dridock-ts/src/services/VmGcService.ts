import type { Colima } from "../infra/Colima.ts";
import type { Docker } from "../infra/Docker.ts";
import type { Limactl } from "../infra/Limactl.ts";
import { RealDocker } from "../infra/Docker.ts";
import { RealLimactl } from "../infra/Limactl.ts";
import type { Context } from "../cli/Context.ts";

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
    private readonly limaHome?: string,
  ) {}

  async run(ctx: Context): Promise<number> {
    ctx.stdout.write(`🧹 pruning orphaned lima disks (no owning colima profile)...\n`);
    const disks = await this.limactl.diskLs(this.limaHome ?? "");
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
      const rc = this.limaHome !== undefined ? await this.limactl.diskDelete(this.limaHome, orphans) : 1;
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

    ctx.stdout.write(`\n✅ vm gc done.\n`);
    ctx.stdout.write(`   (default/human VM left untouched — trim it yourself: colima ssh -p default -- sudo fstrim -av)\n`);
    return 0;
  }
}

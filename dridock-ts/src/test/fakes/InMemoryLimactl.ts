import type { Limactl, LimaDisk } from "../../infra/Limactl.ts";

/**
 * Fake Limactl for unit tests. Seed disks + assert on deletions.
 * Records every diskDelete call.
 */
export class InMemoryLimactl implements Limactl {
  private readonly disks = new Map<string, LimaDisk>();
  readonly deletions: string[][] = [];
  /** RC to return from the NEXT diskDelete call — default 0. */
  nextDeleteRc = 0;

  seedDisk(disk: LimaDisk): void {
    this.disks.set(disk.name, disk);
  }

  async diskLs(_limaHome: string): Promise<readonly LimaDisk[]> {
    void _limaHome;
    return [...this.disks.values()];
  }

  async diskDelete(_limaHome: string, names: readonly string[]): Promise<number> {
    void _limaHome;
    this.deletions.push([...names]);
    const rc = this.nextDeleteRc;
    if (rc === 0) {
      for (const n of names) this.disks.delete(n);
    }
    return rc;
  }
}

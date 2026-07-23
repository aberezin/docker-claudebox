/**
 * `du -sk <path>` — actual on-disk usage in KB. Ports cb_du_k at
 * wrapper.sh:852. Used by `vm usage` for the real Mac footprint
 * (colima's provisioned MAX rarely reflects actual sparse-disk usage).
 *
 * Real impl shells to `du -sk`; test impl seeds path → kb.
 */
export interface DiskProbe {
  /** Actual KB on disk for the path. 0 for missing/inaccessible. */
  usageKb(path: string): Promise<number>;
}

export class RealDiskProbe implements DiskProbe {
  async usageKb(path: string): Promise<number> {
    try {
      const proc = Bun.spawn(["du", "-sk", path], {
        stdout: "pipe", stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return 0;
      const firstToken = text.trim().split(/\s+/)[0] ?? "0";
      const kb = parseInt(firstToken, 10);
      return Number.isFinite(kb) ? kb : 0;
    } catch {
      return 0;
    }
  }
}

/** Test double — pre-seeded path → kb. */
export class StubDiskProbe implements DiskProbe {
  private readonly kb = new Map<string, number>();
  seedUsage(path: string, kb: number): void { this.kb.set(path, kb); }
  async usageKb(path: string): Promise<number> {
    return this.kb.get(path) ?? 0;
  }
}

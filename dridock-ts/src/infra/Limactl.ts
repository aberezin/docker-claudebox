/**
 * `limactl disk ls` + `disk delete` — the subset of limactl dridock needs
 * for `vm usage` and `vm gc`. Ports the `limactl disk ls` / `limactl disk
 * delete` calls at wrapper.sh:887 / :926.
 *
 * macOS-only (limactl ships with lima; colima's default backend uses it).
 * Real impl shells via Bun.spawn; on non-macOS, `limactl` isn't installed
 * and every method returns empty / does nothing.
 */

/** One row from `limactl disk ls` output. */
export interface LimaDisk {
  readonly name: string;
  /** The `SIZE` column — provisioned max, human-readable ("100GiB"). */
  readonly max: string;
}

export interface Limactl {
  /** `LIMA_HOME=<home> limactl disk ls` — returns each disk row. Empty on
   *  missing limactl / unusable LIMA_HOME. */
  diskLs(limaHome: string): Promise<readonly LimaDisk[]>;
  /** `LIMA_HOME=<home> limactl disk delete <names...>`. Best-effort — rc
   *  reflected in return; empty list is no-op. */
  diskDelete(limaHome: string, names: readonly string[]): Promise<number>;
}

export class RealLimactl implements Limactl {
  async diskLs(limaHome: string): Promise<readonly LimaDisk[]> {
    try {
      const proc = Bun.spawn(["limactl", "disk", "ls"], {
        stdout: "pipe", stderr: "ignore",
        env: { ...process.env, LIMA_HOME: limaHome },
      });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return [];
      return parseLimactlDiskLs(text);
    } catch { return []; }
  }

  async diskDelete(limaHome: string, names: readonly string[]): Promise<number> {
    if (names.length === 0) return 0;
    try {
      const proc = Bun.spawn(["limactl", "disk", "delete", ...names], {
        stdout: "ignore", stderr: "ignore",
        env: { ...process.env, LIMA_HOME: limaHome },
      });
      return await proc.exited;
    } catch { return 1; }
  }
}

/**
 * Parse `limactl disk ls` output. Header + rows separated by whitespace;
 * first column is NAME, second is SIZE. Exported for test round-trips.
 */
export function parseLimactlDiskLs(text: string): LimaDisk[] {
  const lines = text.split(/\r?\n/);
  const rows: LimaDisk[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) continue; // skip header
    const line = lines[i]!.trim();
    if (line === "") continue;
    const parts = line.split(/\s+/);
    const name = parts[0];
    const max = parts[1];
    if (name === undefined || name === "" || max === undefined) continue;
    rows.push({ name, max });
  }
  return rows;
}

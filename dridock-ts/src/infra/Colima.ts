/**
 * The Colima CLI surface dridock actually calls. Kept minimal — grows one
 * method per verb that needs it. Real impl uses Bun.spawn on `colima`; test
 * impl (InMemoryColima) seeds `.vms` + records what would have been called.
 */

/** A single row from `colima list --json`. */
export interface VmInfo {
  readonly name: string;
  /** "Running" | "Stopped" | ... — colima's own string, kept verbatim so
   *  callers can render it faithfully without inventing a mapping. */
  readonly status: string;
  /** The reachable IP (empty if the VM hasn't finished bringing up vmnet). */
  readonly address: string;
  readonly cpu?: number;
  readonly memory?: string;
  readonly disk?: string;
}

export interface Colima {
  /** Whole VM inventory — matches `colima list --json`. */
  list(): Promise<readonly VmInfo[]>;
  /** True iff a VM with this profile name is Running (matches
   *  `status == "Running"`). Absent profile → false. */
  isRunning(profile: string): Promise<boolean>;
  /** Look up one VM's info, or undefined if the profile doesn't exist. */
  get(profile: string): Promise<VmInfo | undefined>;
  /** `colima stop --profile <name>`. Idempotent when already stopped. */
  stop(profile: string): Promise<void>;
  /** `colima delete --profile <name> --force`. Idempotent when absent. */
  delete(profile: string): Promise<void>;
}

/** Production impl. */
export class RealColima implements Colima {
  async list(): Promise<readonly VmInfo[]> {
    // colima list --json returns one JSON object per line (JSONL).
    try {
      const proc = Bun.spawn(["colima", "list", "--json"], {
        stdout: "pipe", stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return [];
      return parseColimaListJson(text);
    } catch {
      return [];
    }
  }

  async isRunning(profile: string): Promise<boolean> {
    const info = await this.get(profile);
    return info?.status === "Running";
  }

  async get(profile: string): Promise<VmInfo | undefined> {
    const all = await this.list();
    return all.find((v) => v.name === profile);
  }

  async stop(profile: string): Promise<void> {
    // `colima stop` returns non-zero when the VM is already stopped —
    // that's still success from our POV.
    const proc = Bun.spawn(["colima", "stop", "--profile", profile], {
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited;
  }

  async delete(profile: string): Promise<void> {
    const proc = Bun.spawn(["colima", "delete", "--profile", profile, "--force"], {
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited;
  }
}

/** Parse `colima list --json` output — JSONL, one VM per line. Tolerates
 *  blank lines, trailing whitespace, and lines that fail to parse (skipped
 *  silently — matches bash's awk-based parser). Exported for unit tests. */
export function parseColimaListJson(text: string): VmInfo[] {
  const rows: VmInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const name = typeof j["name"] === "string" ? (j["name"] as string) : "";
      if (name === "") continue;
      rows.push({
        name,
        status: typeof j["status"] === "string" ? (j["status"] as string) : "",
        address: typeof j["address"] === "string" ? (j["address"] as string) : "",
        cpu: typeof j["cpu"] === "number" ? (j["cpu"] as number) : undefined,
        memory: typeof j["memory"] === "string" ? (j["memory"] as string) : undefined,
        disk: typeof j["disk"] === "string" ? (j["disk"] as string) : undefined,
      });
    } catch { /* skip malformed line, matches bash */ }
  }
  return rows;
}

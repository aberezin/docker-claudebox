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

/** Args for `colima start` — matches wrapper.sh:771 cb_colima_start. */
export interface StartOpts {
  /** vCPU count (bash `cb_num` — integer). */
  readonly cpu: number;
  /** Memory (integer GiB — bash strips units via cb_num). */
  readonly memoryGiB: number;
  /** Disk (integer GiB). */
  readonly diskGiB: number;
  /** True → pass `--network-address` for a host-reachable IP. cb-infra
   *  intentionally leaves this off (image store only, no workloads). */
  readonly networkAddress: boolean;
  /** Extra mount args: `--mount PATH[:w]`. Bash builds this for a workspace
   *  outside `$HOME` (colima auto-mounts anything inside `$HOME`). Each
   *  string is one full mount spec, appended verbatim after `--mount`. */
  readonly extraMounts?: readonly string[];
}

/** Args for waitReachable — the col0 interface lags `colima start` by
 *  seconds; caller polls until the reachable IP answers ping. */
export interface WaitReachableOpts {
  /** Max seconds to poll. Bash default: 20 (wrapper.sh:1247). */
  readonly timeoutSec?: number;
  /** Millisecond delay between poll attempts. Test-injectable so
   *  we can drive the loop without real time. Default 1000. */
  readonly pollIntervalMs?: number;
}

export interface Colima {
  /** Whole VM inventory — matches `colima list --json`. */
  list(): Promise<readonly VmInfo[]>;
  /** True iff a VM with this profile name is Running (matches
   *  `status == "Running"`). Absent profile → false. */
  isRunning(profile: string): Promise<boolean>;
  /** Look up one VM's info, or undefined if the profile doesn't exist. */
  get(profile: string): Promise<VmInfo | undefined>;
  /**
   * `colima start --profile <profile> --cpu N --memory M --disk D
   * [--network-address] [--mount X:w ...]`. Returns rc — 0 iff colima
   * reported success. Ports wrapper.sh:771 (the sizing branch of
   * cb_ensure_vm). Never boots cb-infra; caller decides which profile.
   */
  start(profile: string, opts: StartOpts): Promise<number>;
  /** `colima stop --profile <name>`. Idempotent when already stopped. */
  stop(profile: string): Promise<void>;
  /** `colima delete --profile <name> --force`. Idempotent when absent. */
  delete(profile: string): Promise<void>;
  /**
   * Poll `list()` for the profile's reachable IP + probe reachability
   * until one answers or `timeoutSec` elapses. Returns the IP on success,
   * undefined on timeout (best-effort address on timeout matches bash but
   * bash also `return 1`s — we surface that via undefined). Ports
   * cb_wait_reachable at wrapper.sh:1247.
   */
  waitReachable(profile: string, opts?: WaitReachableOpts): Promise<string | undefined>;
}

/** Probes network reachability of a single host. Split out because the ping
 *  primitive is platform-specific and needs to be testable — waitReachable
 *  is otherwise not unit-testable. Real impl uses `ping -c1` with a per-OS
 *  timeout flag; test impl is instantly-scriptable. */
export interface Pinger {
  /** True iff `host` responded within `timeoutMs`. Never throws. */
  reachable(host: string, timeoutMs: number): Promise<boolean>;
}

/** Real ping — Bun.spawn on `ping -c1`. */
export class RealPinger implements Pinger {
  async reachable(host: string, timeoutMs: number): Promise<boolean> {
    if (host === "") return false;
    try {
      // Portability: macOS's `ping -W` is in milliseconds; Linux's `ping
      // -W` is in seconds. Bash uses `timeout 2 ping -c1` to sidestep this
      // — same approach here via AbortSignal so we don't need `timeout`
      // installed.
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const proc = Bun.spawn(["ping", "-c", "1", host], {
          stdout: "ignore", stderr: "ignore",
          signal: ac.signal,
        });
        const rc = await proc.exited;
        return rc === 0;
      } finally { clearTimeout(to); }
    } catch { return false; }
  }
}

/** Production impl. */
export class RealColima implements Colima {
  constructor(private readonly pinger: Pinger = new RealPinger()) {}

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

  async start(profile: string, opts: StartOpts): Promise<number> {
    // Matches wrapper.sh:771 exactly. cb-infra is a separate concern —
    // caller decides whether to pass `--network-address`.
    const args: string[] = [
      "colima", "start", "-p", profile,
      "--cpu", String(opts.cpu),
      "--memory", String(opts.memoryGiB),
      "--disk", String(opts.diskGiB),
    ];
    if (opts.networkAddress) args.push("--network-address");
    for (const m of opts.extraMounts ?? []) args.push("--mount", m);
    const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
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

  async waitReachable(profile: string, opts: WaitReachableOpts = {}): Promise<string | undefined> {
    const timeoutSec = opts.timeoutSec ?? 20;
    const pollIntervalMs = opts.pollIntervalMs ?? 1000;
    const deadline = performance.now() + timeoutSec * 1000;
    let lastAddress = "";
    while (performance.now() < deadline) {
      const vm = await this.get(profile);
      const address = vm?.address ?? "";
      if (address !== "") {
        lastAddress = address;
        if (await this.pinger.reachable(address, 2000)) return address;
      }
      await sleep(pollIntervalMs);
    }
    // Bash returns the best-effort address AND rc 1; we collapse both
    // to `undefined` so the caller can't accidentally use a stale IP.
    // The last-seen address is still recoverable via a fresh get().
    void lastAddress;
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Guard: only operate on colima profiles that start with "cb-". Ports
 * cb_guard_profile at wrapper.sh:600 — protects against accidentally
 * `colima stop`-ing the human's default VM.
 */
export function isCbProfile(profile: string): boolean {
  return /^cb-.+/.test(profile);
}

/**
 * Count running project VMs (cb-* profiles, EXCLUDING cb-infra which is
 * the shared image-store). Ports cb_running_cb_count via cb_running_cb_profiles.
 */
export function countRunningProjectVms(vms: readonly VmInfo[]): number {
  return vms.filter((v) => v.name.startsWith("cb-") && v.name !== "cb-infra" && v.status === "Running").length;
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

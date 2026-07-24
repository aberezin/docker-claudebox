import type { Colima, StartOpts, VmInfo, WaitReachableOpts, Pinger } from "../../infra/Colima.ts";

/**
 * Fake Colima for unit tests. Seed VMs, then assert on what `.stops` /
 * `.deletions` / `.starts` recorded.
 */
export class InMemoryColima implements Colima {
  private readonly vms = new Map<string, VmInfo>();
  readonly stops: string[] = [];
  readonly deletions: string[] = [];
  readonly starts: Array<{ profile: string; opts: StartOpts }> = [];
  /** RC to return from the next .start() — default 0. Set to non-zero
   *  to script "colima start failed" scenarios. */
  nextStartRc = 0;
  /** Deterministic reachability outcome for waitReachable — default
   *  true (return the seeded address immediately). Set false to model a
   *  timeout scenario. */
  nextWaitReachableSuccess = true;

  seedVm(info: VmInfo): void {
    this.vms.set(info.name, info);
  }

  async list(): Promise<readonly VmInfo[]> {
    return [...this.vms.values()];
  }

  async isRunning(profile: string): Promise<boolean> {
    return this.vms.get(profile)?.status === "Running";
  }

  async get(profile: string): Promise<VmInfo | undefined> {
    return this.vms.get(profile);
  }

  async start(profile: string, opts: StartOpts): Promise<number> {
    this.starts.push({ profile, opts });
    if (this.nextStartRc === 0) {
      // Simulate a successful start: mark the VM Running with a
      // deterministic address so downstream tests can proceed.
      this.vms.set(profile, {
        name: profile,
        status: "Running",
        address: opts.networkAddress ? "192.168.64.100" : "",
        cpu: opts.cpu,
        memory: `${opts.memoryGiB}GiB`,
        disk: `${opts.diskGiB}GiB`,
      });
    }
    return this.nextStartRc;
  }

  async stop(profile: string): Promise<void> {
    this.stops.push(profile);
    const existing = this.vms.get(profile);
    if (existing !== undefined) this.vms.set(profile, { ...existing, status: "Stopped", address: "" });
  }

  async delete(profile: string): Promise<void> {
    this.deletions.push(profile);
    this.vms.delete(profile);
  }

  async waitReachable(profile: string, _opts?: WaitReachableOpts): Promise<string | undefined> {
    void _opts;
    if (!this.nextWaitReachableSuccess) return undefined;
    const vm = this.vms.get(profile);
    return vm !== undefined && vm.address !== "" ? vm.address : undefined;
  }

  readonly sshCalls: Array<{ profile: string; cmd: readonly string[]; rc: number }> = [];
  /** RC scripted for the NEXT ssh call — default 0. */
  nextSshRc = 0;
  async ssh(profile: string, cmd: readonly string[]): Promise<number> {
    const rc = this.nextSshRc;
    this.sshCalls.push({ profile, cmd, rc });
    return rc;
  }
}

/** Test double for the ping primitive — reachable() returns a scripted bool. */
export class StubPinger implements Pinger {
  private readonly answers = new Map<string, boolean>();
  seedReachable(host: string, reachable: boolean): void {
    this.answers.set(host, reachable);
  }
  async reachable(host: string, _timeoutMs: number): Promise<boolean> {
    void _timeoutMs;
    return this.answers.get(host) ?? false;
  }
}

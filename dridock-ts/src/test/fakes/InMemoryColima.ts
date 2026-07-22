import type { Colima, VmInfo } from "../../infra/Colima.ts";

/**
 * Fake Colima for unit tests. Seed VMs, then assert on what `.stops` /
 * `.deletions` recorded.
 */
export class InMemoryColima implements Colima {
  private readonly vms = new Map<string, VmInfo>();
  readonly stops: string[] = [];
  readonly deletions: string[] = [];

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

  async stop(profile: string): Promise<void> {
    this.stops.push(profile);
    const existing = this.vms.get(profile);
    if (existing !== undefined) this.vms.set(profile, { ...existing, status: "Stopped", address: "" });
  }

  async delete(profile: string): Promise<void> {
    this.deletions.push(profile);
    this.vms.delete(profile);
  }
}

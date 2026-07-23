import type { HostGit } from "../../infra/HostGit.ts";

/** Test double for `git config <key>` — pre-seeded key→value map. */
export class StubHostGit implements HostGit {
  private readonly values = new Map<string, string>();
  seedConfig(key: string, value: string): void {
    this.values.set(key, value);
  }
  async configGet(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
}

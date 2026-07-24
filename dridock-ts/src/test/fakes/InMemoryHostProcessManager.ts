import type { HostProcessManager, SpawnDetachedOpts } from "../../infra/HostProcessManager.ts";

/**
 * Fake HostProcessManager — records what spawnDetached would have
 * launched (argv + opts) without touching real processes. Tests
 * seed .alive to control what isAlive returns for a given pid.
 */
export class InMemoryHostProcessManager implements HostProcessManager {
  readonly spawns: Array<{ argv: readonly string[]; opts: SpawnDetachedOpts; pid: number }> = [];
  readonly kills: number[] = [];
  /** Which pids are considered alive. Tests set entries here to model
   *  "a bridge is already running" scenarios. */
  readonly alive = new Set<number>();
  /** Next pid handed out by spawnDetached — starts at 1000, increments. */
  nextPid = 1000;
  /** Force spawnDetached to throw (models `ENOENT` for a missing binary). */
  spawnError: Error | undefined;

  async spawnDetached(argv: readonly string[], opts: SpawnDetachedOpts): Promise<number> {
    if (this.spawnError !== undefined) throw this.spawnError;
    const pid = this.nextPid++;
    this.spawns.push({ argv, opts, pid });
    this.alive.add(pid);
    return pid;
  }

  async kill(pid: number): Promise<boolean> {
    this.kills.push(pid);
    const wasAlive = this.alive.has(pid);
    this.alive.delete(pid);
    return wasAlive;
  }

  async isAlive(pid: number): Promise<boolean> {
    return this.alive.has(pid);
  }
}

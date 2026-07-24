import { openSync, closeSync } from "node:fs";

/**
 * Narrow abstraction over spawning + managing long-lived detached
 * processes on the host — the browser-bridge Chrome + Python forwarder,
 * the host-agent Python daemon. All three outlive the wrapper
 * invocation that starts them, so this is intentionally NOT
 * `ContainerRuntime`-style (which awaits exit) but detach-and-return.
 *
 * The Real implementation shells out via Bun.spawn + node:fs; the
 * InMemory fake records what would have been spawned and stubs pid
 * liveness so services can be tested without actually launching Chrome.
 */
export interface HostProcessManager {
  /**
   * Spawn `argv[0]` with `argv[1..]` detached from the parent. Returns
   * the child's PID. Not awaited — the child keeps running after this
   * process exits. stdout+stderr redirected to `logFile` (append mode,
   * created if absent). stdin is `/dev/null`.
   */
  spawnDetached(argv: readonly string[], opts: SpawnDetachedOpts): Promise<number>;

  /** SIGTERM to `pid`. Returns true if a signal was delivered (pid existed),
   *  false if the pid was already gone. Never throws. */
  kill(pid: number): Promise<boolean>;

  /** True iff a process with `pid` is currently alive AND owned by this
   *  user (i.e., we could signal it). Matches bash `kill -0 $pid` semantics.
   *  Never throws. */
  isAlive(pid: number): Promise<boolean>;
}

export interface SpawnDetachedOpts {
  /** File path where stdout+stderr get appended. */
  readonly logFile: string;
  /** Env vars added to the child's env (merged over process.env). */
  readonly env?: Record<string, string>;
  /** Optional cwd for the child. Default: parent's cwd. */
  readonly cwd?: string;
}

export class RealHostProcessManager implements HostProcessManager {
  async spawnDetached(argv: readonly string[], opts: SpawnDetachedOpts): Promise<number> {
    // Open the log file for append; pass the fd to both stdout + stderr.
    // We close our copy of the fd after spawn; the child keeps its own.
    const logFd = openSync(opts.logFile, "a", 0o644);
    try {
      const proc = Bun.spawn([...argv], {
        stdio: ["ignore", logFd, logFd],
        env: opts.env !== undefined ? { ...process.env, ...opts.env } : undefined,
        cwd: opts.cwd,
      });
      // Detach from our event loop so we can exit while the child keeps
      // running. Matches `nohup ... &` semantics.
      proc.unref();
      const pid = proc.pid;
      if (pid === undefined) throw new Error(`spawnDetached: no pid returned for ${argv.join(" ")}`);
      return pid;
    } finally {
      closeSync(logFd);
    }
  }

  async kill(pid: number): Promise<boolean> {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false; // ESRCH (no such process) or EPERM — both mean "nothing to signal"
    }
  }

  async isAlive(pid: number): Promise<boolean> {
    // `process.kill(pid, 0)` — no signal actually sent, only checks
    // existence + permission (matches `kill -0` in bash).
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

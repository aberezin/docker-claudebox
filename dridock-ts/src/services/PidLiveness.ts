/**
 * Pid-liveness probe with cmdline verification — the "is this fetcher
 * really our fetcher?" check that spec #56 open loop #4 called for.
 *
 * ## Why cmdline verification isn't optional
 *
 * `kill(pid, 0)` on its own answers "is anything alive under this pid".
 * That's a false-positive class after a reboot (or any pid wraparound):
 * the recorded pid is very likely held by an unrelated process, `kill`
 * succeeds, and the caller concludes "our fetcher is alive". Silent
 * starvation with a green light on `dridock team fetcher status`.
 *
 * The fix is a two-part check:
 *   1. `probe.isRunning(pid)` — cheap existence check (kill -0).
 *   2. `probe.getCommandLine(pid)` — must contain BOTH the hardcoded
 *      "dridock team watch" (the tool) AND the caller-supplied
 *      substring (the inbox path — unique per agent+env by
 *      construction).
 *
 * Both parts are required. If we can't get the cmdline (ps failed,
 * permission denied), treat as dead — better a false-dead (respawn) than
 * a false-alive (silent starvation). Same reasoning removes the
 * "EPERM=alive" shortcut some liveness probes ship with: a pid owned by
 * root after a reboot reads as EPERM under our uid, and without cmdline
 * confirmation we'd have the exact green-light-on-starvation failure.
 *
 * ## Structure
 *
 * The `ProcessProbe` interface is the seam — real code uses
 * `RealProcessProbe` (spawns `ps -p <pid> -o command=`), tests use a
 * fake probe with a pre-seeded pid → cmdline map. Same isPidAlive
 * function in both paths.
 */

export interface ProcessProbe {
  /** True if a process with this pid exists (regardless of who owns
   *  it). Real impl: `process.kill(pid, 0)` swallowing ESRCH. */
  isRunning(pid: number): boolean;
  /** The full command line for a running pid, or `undefined` if the
   *  process doesn't exist / we can't read its cmdline. Real impl:
   *  `ps -p <pid> -o command=` (macOS + Linux; not `-ww` — ps returns
   *  enough width by default in every version we've tested). */
  getCommandLine(pid: number): string | undefined;
}

/**
 * Two-part liveness probe: (1) pid exists, (2) cmdline contains BOTH
 * "dridock team watch" AND `expectedCmdlineContains`.
 *
 * When `expectedCmdlineContains` is `undefined`, the cmdline check is
 * skipped and this is a bare pid-existence probe. Callers with pid
 * from a pidfile they wrote should always pass a substring — the
 * "does this pid belong to our fetcher" question is exactly what the
 * cmdline check answers, and skipping it re-opens the wraparound
 * false-positive class.
 */
export function isPidAlive(
  pid: number,
  expectedCmdlineContains: string | undefined,
  probe: ProcessProbe,
): boolean {
  if (!probe.isRunning(pid)) return false;
  if (expectedCmdlineContains === undefined) return true;
  const cmdline = probe.getCommandLine(pid);
  if (cmdline === undefined) return false;
  return cmdline.includes("dridock team watch") && cmdline.includes(expectedCmdlineContains);
}

/** Production probe — the isRunning check uses `process.kill(pid, 0)`
 *  (no signal sent; existence probe only), and getCommandLine spawns
 *  `ps -p <pid> -o command=` via Bun.spawnSync (fastest) or falls back
 *  to node's child_process.execSync when running under a pure-node
 *  test-runner. */
export class RealProcessProbe implements ProcessProbe {
  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH → no such process. EPERM → exists but we can't signal it,
      // but without a cmdline read we can't confirm it's OUR fetcher,
      // so degrade to false. RealProcessProbe.getCommandLine will run
      // next and can still succeed (ps doesn't need signal permission),
      // but only if pid exists — so this early return under EPERM
      // means we lose the ability to detect an alien-owned lookalike.
      // That's the safe direction: false-dead + respawn beats
      // false-alive + silent starvation.
      return false;
    }
  }

  getCommandLine(pid: number): string | undefined {
    try {
      const bun = (globalThis as { Bun?: { spawnSync?: (args: string[]) => { stdout: Uint8Array; exitCode: number } } }).Bun;
      if (bun?.spawnSync !== undefined) {
        const res = bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
        if (res.exitCode !== 0) return undefined;
        return new TextDecoder().decode(res.stdout);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require("node:child_process") as { execSync: (cmd: string, opts: { encoding: string }) => string };
      return execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" });
    } catch {
      return undefined;
    }
  }
}

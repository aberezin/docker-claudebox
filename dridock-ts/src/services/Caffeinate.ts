import type { EnvResolver } from "../domain/EnvResolver.ts";
import type { TextWriter } from "../cli/Context.ts";

/**
 * `DRIDOCK_CAFFEINATE` (#110): keep the Mac awake for a foreground
 * `dridock start` (interactive or `-p`), so a long run doesn't stall when
 * the machine idles to sleep and Colima suspends.
 *
 * Ports `cb_caffeinate` (wrapper.sh at v3.4.1, lines 2125–2140), which the
 * 4.0 TS port dropped while the env-var doc kept promising it. It runs
 * `caffeinate -dimsu -w <this pid>`, so the hold ends when this dridock
 * process exits, even if it is killed. That's the same lifetime the
 * session has, because `start` stays in the foreground while it's attached.
 * `-dimsu` prevents display, idle, disk and system sleep and asserts the
 * user is active. macOS only fully holds system sleep on AC power.
 *
 * The on/off rule matches 3.x: empty, `0`, `false`, `no` or `off` mean
 * off, and anything else means on. Unlike 3.x, a requested hold that
 * can't be had (no `caffeinate` binary, e.g. the Linux backend) is said on
 * stderr instead of a debug-only line. The user set it to be protected and
 * should know they aren't.
 */

export interface KeepAwake {
  /** True when the `caffeinate` binary is on PATH. */
  available(): boolean;
  /** Start `caffeinate` tied to `pid`, detached. Never throws. */
  hold(pid: number): void;
}

export class RealKeepAwake implements KeepAwake {
  available(): boolean {
    return Bun.which("caffeinate") !== null;
  }
  hold(pid: number): void {
    try {
      const proc = Bun.spawn(["caffeinate", "-dimsu", "-w", String(pid)], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.unref();
    } catch { /* reported by the caller via available(); a spawn race is not worth crashing start */ }
  }
}

export function caffeinateRequested(env: EnvResolver): boolean {
  const v = env.get("CAFFEINATE");
  if (v === undefined) return false;
  return !/^(|0|false|no|off)$/i.test(v.trim());
}

/** Applies DRIDOCK_CAFFEINATE for this process. Returns whether a hold was started. */
export function maybeCaffeinate(env: EnvResolver, keepAwake: KeepAwake, pid: number, stderr: TextWriter): boolean {
  if (!caffeinateRequested(env)) return false;
  if (!keepAwake.available()) {
    stderr.write(`⚠️  DRIDOCK_CAFFEINATE is set, but there is no 'caffeinate' on PATH (it is macOS-only): nothing is keeping this machine awake.\n`);
    return false;
  }
  keepAwake.hold(pid);
  return true;
}

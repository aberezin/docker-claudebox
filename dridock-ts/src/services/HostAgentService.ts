import type { FileSystem } from "../infra/FileSystem.ts";
import type { HostProcessManager } from "../infra/HostProcessManager.ts";
import { stateHome } from "../domain/paths.ts";

/**
 * `dridock host-agent up|down|status` — port of wrapper.sh:1689-1720
 * (cb_host_agent_up + _down + _status). The Python HTTP daemon
 * (`host-agent.py`) is unchanged — this only ports the bash
 * orchestration around it: py resolution, spawn, pid + token files,
 * post-spawn liveness verify.
 *
 * The agent is OPT-IN and TRUSTED — the token grants remote exec of an
 * allowlisted set (colima/limactl) from a claudebot back to the Mac.
 * Bind is gateway-only (192.168.64.1) not LAN. See docs/design/backends.md.
 */

export interface HostAgentDeps {
  readonly fs: FileSystem;
  readonly processes: HostProcessManager;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  /**
   * How to find `host-agent.py`. The command layer passes candidate
   * paths in the order bash checks them: env override, sibling of the
   * dridock binary, `<share>/claudebox/host-agent.py`. First one that
   * `fs.exists()` wins. Undefined return → error.
   */
  readonly pyCandidates: readonly string[];
  /** Sleep after spawn before checking liveness. Bash sleeps 1s; tests
   *  pass no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** RNG for the 24-byte auth token → 48 hex chars. */
  readonly randomHex?: (byteCount: number) => string;
}

export type HostAgentUpOutcome =
  | { kind: "py-not-found"; candidates: readonly string[] }
  | { kind: "already-up"; pid: number; bind: string; port: string }
  | { kind: "up"; pid: number; bind: string; port: string; logPath: string }
  | { kind: "spawn-failed"; logPath: string; logTail: string };

export interface HostAgentStatusOutcome {
  readonly running: boolean;
  readonly pid?: number;
  readonly bind: string;
  readonly port: string;
}

export class HostAgentService {
  constructor(private readonly deps: HostAgentDeps) {}

  async up(): Promise<HostAgentUpOutcome> {
    const bind = this.envOr("DRIDOCK_HOST_AGENT_BIND", "192.168.64.1");
    const port = this.envOr("DRIDOCK_HOST_AGENT_PORT", "9280");
    const { pidFile, tokenFile, logFile } = await this.paths();

    // Already-up short-circuit (bash: wrapper.sh:1692-1694).
    const existing = await this.readPid(pidFile);
    if (existing !== undefined && (await this.deps.processes.isAlive(existing))) {
      return { kind: "already-up", pid: existing, bind, port };
    }

    const py = await this.resolvePy();
    if (py === undefined) return { kind: "py-not-found", candidates: this.deps.pyCandidates };

    // Fresh token (48 hex chars from 24 bytes — matches bash's
    // `head -c 24 /dev/urandom | od -An -tx1`).
    const rand = this.deps.randomHex ?? defaultRandomHex;
    const token = rand(24);
    await this.deps.fs.writeText(tokenFile, token, { mode: 0o600 });

    const pid = await this.deps.processes.spawnDetached(
      ["python3", py],
      {
        logFile,
        env: {
          CB_HOST_AGENT_TOKEN: token,
          CB_HOST_AGENT_BIND: bind,
          CB_HOST_AGENT_PORT: port,
        },
      },
    );
    await this.deps.fs.writeText(pidFile, String(pid));

    // Verify — bash sleeps 1s then kill -0 to catch daemons that
    // crashed immediately (bad python path, port in use, …).
    await (this.deps.sleep ?? defaultSleep)(1000);
    if (!(await this.deps.processes.isAlive(pid))) {
      const log = (await this.deps.fs.readTextOrUndefined(logFile)) ?? "";
      const tail = log.trim().split("\n").slice(-3).join("\n");
      // Don't remove pid file — user may want to inspect. But the
      // daemon is dead, so surface it.
      return { kind: "spawn-failed", logPath: logFile, logTail: tail };
    }
    return { kind: "up", pid, bind, port, logPath: logFile };
  }

  async down(): Promise<{ killed: boolean; pid?: number }> {
    const { pidFile, tokenFile } = await this.paths();
    const pid = await this.readPid(pidFile);
    let killed = false;
    if (pid !== undefined) {
      killed = await this.deps.processes.kill(pid);
      await this.deps.fs.removeFile(pidFile);
    }
    await this.deps.fs.removeFile(tokenFile);
    return { killed, pid };
  }

  async status(): Promise<HostAgentStatusOutcome> {
    const bind = this.envOr("DRIDOCK_HOST_AGENT_BIND", "192.168.64.1");
    const port = this.envOr("DRIDOCK_HOST_AGENT_PORT", "9280");
    const { pidFile } = await this.paths();
    const pid = await this.readPid(pidFile);
    const running = pid !== undefined && (await this.deps.processes.isAlive(pid));
    return { running, pid: running ? pid : undefined, bind, port };
  }

  private envOr(key: string, fallback: string): string {
    const v = this.deps.env[key];
    return v !== undefined && v !== "" ? v : fallback;
  }

  private async paths(): Promise<{ pidFile: string; tokenFile: string; logFile: string }> {
    const home = await stateHome(this.deps.fs, this.deps.env, this.deps.home, "host-agent");
    await this.deps.fs.mkdirRecursive(home);
    return {
      pidFile: `${home}/pid`,
      tokenFile: `${home}/token`,
      logFile: `${home}/log`,
    };
  }

  private async readPid(pidFile: string): Promise<number | undefined> {
    const text = await this.deps.fs.readTextOrUndefined(pidFile);
    if (text === undefined) return undefined;
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private async resolvePy(): Promise<string | undefined> {
    for (const p of this.deps.pyCandidates) {
      if (p !== "" && await this.deps.fs.exists(p)) return p;
    }
    return undefined;
  }
}

function defaultRandomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

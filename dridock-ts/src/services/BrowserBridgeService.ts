import type { FileSystem } from "../infra/FileSystem.ts";
import type { HostProcessManager } from "../infra/HostProcessManager.ts";
import { stateHome, xdgRoot } from "../domain/paths.ts";

/**
 * `dridock browser-bridge up|down` — port of wrapper.sh:1592-1670
 * (cb_bridge_up + cb_bridge_down). The Python TCP forwarder script
 * (`forward.py`) is unchanged — this only ports the bash *orchestration*
 * around it: paths, spawning, pid-file, per-project marker, and the
 * user-visible prompt lines.
 *
 * Bash retains cb_bridge_up for one deprecation cycle so `dridock`
 * (bash wrapper) continues to work; `dridock-ts` uses this service and
 * has no BashDelegate for browser-bridge.
 */

export interface BrowserBridgeDeps {
  readonly fs: FileSystem;
  readonly processes: HostProcessManager;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  /** RNG for the 8-hex-digit window-title hash. Defaults to
   *  crypto.getRandomValues; tests inject a deterministic one. */
  readonly randomHex?: (byteCount: number) => string;
  /** Sleep between spawning Chrome and spawning the forwarder — bash
   *  does `sleep 2` here for Chrome to bind its port before the
   *  forwarder connects. Tests pass a no-op; prod uses `Bun.sleep(2000)`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type BrowserBridgeUpOutcome =
  | { kind: "chrome-not-found"; chromePath: string }
  | {
      kind: "up";
      windowTitle: string;
      url: string;
      profile: string;
      alreadyRunning: boolean;
      markerPath: string;
    };

export class BrowserBridgeService {
  constructor(private readonly deps: BrowserBridgeDeps) {}

  async up(projectId: string): Promise<BrowserBridgeUpOutcome> {
    const chromeBin = this.deps.env["DRIDOCK_CHROME"]
      ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!(await this.deps.fs.exists(chromeBin))) {
      return { kind: "chrome-not-found", chromePath: chromeBin };
    }

    const port = this.envOr("DRIDOCK_CDP_PORT", "9223");
    const chromePort = this.envOr("DRIDOCK_CDP_CHROME_PORT", "9222");
    const bind = this.envOr("DRIDOCK_CDP_BIND", "192.168.64.1");

    const home = await stateHome(this.deps.fs, this.deps.env, this.deps.home, "cdp");
    await this.deps.fs.mkdirRecursive(home);
    const profile = this.deps.env["DRIDOCK_CDP_PROFILE"] ?? `${home}/chrome-debug-profile`;
    const forwardPy = `${home}/forward.py`;
    const pidsFile = `${home}/pids`;
    const hashFile = `${home}/window-hash`;
    const chromeLog = `${home}/chrome.log`;
    const forwardLog = `${home}/forward.log`;

    // Regenerate forward.py every up — bind/port env may have changed,
    // and the file is tiny + deterministic (bash-parity).
    await this.deps.fs.writeText(forwardPy, forwarderPython(bind, Number(port), Number(chromePort)));

    // Refresh policy (bash: wrapper.sh:1625-1633) — check whether the
    // prior bridge is still alive before reusing state. New Chrome →
    // new identity hash.
    const priorPids = await this.readPids(pidsFile);
    const anyAlive = await this.anyAlive(priorPids);

    const hash = await this.ensureWindowHash(hashFile, anyAlive);
    const windowTitle = `Claudebox Chrome -- ${hash}`;
    const welcomeUrl = welcomeUrlOf(windowTitle, bind, port);

    if (!anyAlive) {
      const chromePid = await this.deps.processes.spawnDetached(
        [chromeBin,
          `--remote-debugging-port=${chromePort}`,
          `--user-data-dir=${profile}`,
          "--remote-allow-origins=*",
          "--no-first-run",
          "--no-default-browser-check",
          welcomeUrl],
        { logFile: chromeLog },
      );
      // Give Chrome ~2s to bind its port before the forwarder tries to
      // proxy. Matches bash's `sleep 2`; tests inject a no-op.
      await (this.deps.sleep ?? defaultSleep)(2000);
      const forwardPid = await this.deps.processes.spawnDetached(
        ["python3", forwardPy],
        { logFile: forwardLog },
      );
      await this.deps.fs.writeText(pidsFile, `${chromePid} ${forwardPid}`);
    }

    const url = `http://${bind}:${port}`;
    const markerPath = await this.markerFor(projectId);
    await this.deps.fs.mkdirRecursive(dirOf(markerPath));
    await this.deps.fs.writeText(markerPath, url);

    return { kind: "up", windowTitle, url, profile, alreadyRunning: anyAlive, markerPath };
  }

  async down(projectId: string): Promise<{ markerPath: string; pidsKilled: number[] }> {
    const home = await stateHome(this.deps.fs, this.deps.env, this.deps.home, "cdp");
    const pidsFile = `${home}/pids`;
    const hashFile = `${home}/window-hash`;

    const priorPids = await this.readPids(pidsFile);
    for (const pid of priorPids) await this.deps.processes.kill(pid);
    await this.deps.fs.removeFile(pidsFile);
    await this.deps.fs.removeFile(hashFile);

    const markerPath = await this.markerFor(projectId);
    await this.deps.fs.removeFile(markerPath);
    return { markerPath, pidsKilled: priorPids };
  }

  private envOr(key: string, fallback: string): string {
    const v = this.deps.env[key];
    return v !== undefined && v !== "" ? v : fallback;
  }

  private async readPids(pidsFile: string): Promise<number[]> {
    const text = await this.deps.fs.readTextOrUndefined(pidsFile);
    if (text === undefined || text.trim() === "") return [];
    return text.trim().split(/\s+/).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  }

  private async anyAlive(pids: readonly number[]): Promise<boolean> {
    for (const p of pids) if (await this.deps.processes.isAlive(p)) return true;
    return false;
  }

  private async ensureWindowHash(hashFile: string, priorAlive: boolean): Promise<string> {
    const rand = this.deps.randomHex ?? defaultRandomHex;
    // Regenerate on fresh session (prior bridge dead). Reuse on 2nd `up`
    // while running. If reuse-path finds an empty/missing file (shouldn't
    // happen with proper `down`), regenerate anyway rather than emit "".
    if (!priorAlive) {
      const h = rand(4);
      await this.deps.fs.writeText(hashFile, h);
      return h;
    }
    const existing = (await this.deps.fs.readTextOrUndefined(hashFile))?.trim();
    if (existing !== undefined && existing !== "") return existing;
    const h = rand(4);
    await this.deps.fs.writeText(hashFile, h);
    return h;
  }

  private async markerFor(projectId: string): Promise<string> {
    const xdg = await xdgRoot(this.deps.fs, this.deps.env, this.deps.home);
    return `${xdg}/projects/${projectId}/.cdp-url`;
  }
}

/** The full Python TCP forwarder source. Ports the `PYEOF` heredoc at
 *  wrapper.sh:1597-1619 verbatim except for the substituted bind/port. */
export function forwarderPython(bind: string, listenPort: number, chromePort: number): string {
  return `import socket, threading
LISTEN=('${bind}', ${listenPort}); DEST=('127.0.0.1', ${chromePort})
def pipe(a,b):
    try:
        while True:
            d=a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    finally:
        for s in (a,b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def handle(c):
    try: d=socket.create_connection(DEST)
    except OSError: c.close(); return
    threading.Thread(target=pipe,args=(c,d),daemon=True).start(); pipe(d,c)
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(LISTEN); s.listen(64)
while True:
    c,_=s.accept(); threading.Thread(target=handle,args=(c,),daemon=True).start()
`;
}

function welcomeUrlOf(windowTitle: string, bind: string, port: string): string {
  return `data:text/html;charset=utf-8,<html><head><title>${windowTitle}</title></head><body style='font-family:-apple-system;padding:2em;color:#333;max-width:44em;margin:auto'><h1 style='color:#c05621'>${windowTitle}</h1><p>This is the claudebot's <b>dedicated CDP debug Chrome</b>. It's driven by <code>cb-browser cdp</code> / <code>cb-browser script-cdp</code> via the CDP bridge on <code>${bind}:${port}</code>.</p><p style='color:#888;font-size:0.9em'>If you navigate this tab, the window title changes to match — leave this tab open (or reopen this URL) if you want the marker back.</p></body></html>`;
}

function defaultRandomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.substring(0, i);
}

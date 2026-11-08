import type { FileSystem } from "../infra/FileSystem.ts";
import type { HostProcessManager } from "../infra/HostProcessManager.ts";
import { stateHome, xdgRoot } from "../domain/paths.ts";
import type { ProcessProbe } from "./PidLiveness.ts";
import { RealProcessProbe } from "./PidLiveness.ts";

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
  /** CDP socket probe. After spawning (or on reuse) `up()` verifies that
   *  `http://${bind}:${port}/json/version` actually responds — pids being
   *  alive doesn't mean the socket is alive (#94: a stale-bind after colima
   *  restart gives "listener exists but VM gets Connection refused"). Returns
   *  true iff the response is OK within `timeoutMs`. Defaults to a
   *  `fetch`-based GET; tests inject a stub. */
  readonly cdpProbe?: (url: string, timeoutMs: number) => Promise<boolean>;
  /** Cmdline reader for the `status` verb's liveness check (#93). Pids under
   *  `~/.config/dridock/cdp/pids` outlive the processes they describe (the
   *  file is written at `up` and only removed at `down`), so "is this pid
   *  our forwarder" needs cmdline verification, not just kill -0 — same
   *  lesson as #90's fetcher check. Defaults to `RealProcessProbe`; tests
   *  inject a fake. */
  readonly processProbe?: ProcessProbe;
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
    }
  | {
      /** Pids may be alive (reuse path: they ARE alive by definition) but the
       *  CDP socket didn't answer within the retry budget. Marker is NOT
       *  written on this path — pointing it at a dead socket is the silent-
       *  success class the project rejects. Caller surfaces with the right
       *  remediation (`down && up` on alreadyRunning, chromeLog/forwardLog
       *  inspection on a fresh spawn). */
      kind: "probe-failed";
      bind: string;
      port: string;
      alreadyRunning: boolean;
      chromeLog: string;
      forwardLog: string;
      attempts: number;
    };

/**
 * Result shape for `BrowserBridgeService.status()` — read-only snapshot (#93).
 * Three distinguishable states:
 *   - `down`                 — no pidsfile, or none of the recorded pids pass
 *                              the live+cmdline check. Includes the "nothing
 *                              is running" case AND the "pidfile from a prior
 *                              Chrome that quit" case; from the caller's
 *                              perspective these are the same actionable
 *                              state.
 *   - `up-and-responding`    — pids pass live+cmdline AND the CDP socket
 *                              responds within one probe (no retries — this
 *                              is a snapshot, not an attempt).
 *   - `up-but-socket-dead`   — pids pass live+cmdline BUT the CDP socket
 *                              doesn't answer. The exact #94 stale-bind case,
 *                              named so callers can surface the right
 *                              remediation (`down && up`).
 */
export type BrowserBridgeStatusOutcome = {
  kind: "down" | "up-and-responding" | "up-but-socket-dead";
  bind: string;
  port: string;
  url: string;
  pidsFilePath: string;
  pidsFileExists: boolean;
  pids: readonly {
    pid: number;
    alive: boolean;
    cmdlineMatches: boolean | undefined;   // undefined = couldn't check cmdline
    expectedCmdline: string;
  }[];
  projectId: string;
  markerPath: string;
  markerExists: boolean;
  markerUrl: string | undefined;
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
      // Quiet this debug profile before spawn: `dridock browser-bridge down`
      // kills the pid, so Chrome writes exit_type=Crashed on shutdown and shows
      // the "Restore pages?" bubble on the next up. #84.
      //
      // MERGE, never replace. Preferences is Chrome's main config document —
      // window bounds, per-site permissions (clipboard, notifications, camera),
      // DevTools settings, zoom levels, extension state. Overwriting it would
      // fix the bubble by throwing all of that away on every restart: a
      // script-cdp run that granted clipboard permission would lose it on the
      // next `up`. The five keys we care about are a DEFAULT, not a lock.
      const prefsPath = `${profile}/Default/Preferences`;
      await this.deps.fs.mkdirRecursive(`${profile}/Default`);
      const existing = await this.deps.fs.readTextOrUndefined(prefsPath);
      await this.deps.fs.writeTextAtomic(prefsPath, quietProfilePreferences(existing));

      const chromePid = await this.deps.processes.spawnDetached(
        [chromeBin,
          `--remote-debugging-port=${chromePort}`,
          `--user-data-dir=${profile}`,
          "--remote-allow-origins=*",
          "--no-first-run",
          "--no-default-browser-check",
          "--hide-crash-restore-bubble",
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

    // Probe the CDP socket before claiming success (#94). Fresh spawn: retry
    // because Chrome needs a moment to bind post-exec. Reuse path: one shot —
    // if the "already up" pids can't serve, something is wrong NOW and
    // retrying won't resolve it (stale bind after colima restart, zombie
    // forwarder, firewall change). Writing the marker before probing would
    // leave a working-looking url pointing at a dead socket.
    const probe = this.deps.cdpProbe ?? defaultCdpProbe;
    const probeUrl = `http://${bind}:${port}/json/version`;
    const maxAttempts = anyAlive ? 1 : 6;      // reuse: 1. fresh: 6×500ms = 3s
    let attempts = 0;
    let probeOk = false;
    for (; attempts < maxAttempts; attempts++) {
      if (await probe(probeUrl, 2000)) {
        probeOk = true;
        attempts++;
        break;
      }
      if (attempts + 1 < maxAttempts) {
        await (this.deps.sleep ?? defaultSleep)(500);
      }
    }
    if (!probeOk) {
      return {
        kind: "probe-failed",
        bind, port,
        alreadyRunning: anyAlive,
        chromeLog, forwardLog,
        attempts,
      };
    }

    const url = `http://${bind}:${port}`;
    const markerPath = await this.markerFor(projectId);
    await this.deps.fs.mkdirRecursive(dirOf(markerPath));
    await this.deps.fs.writeText(markerPath, url);

    return { kind: "up", windowTitle, url, profile, alreadyRunning: anyAlive, markerPath };
  }

  /**
   * `dridock browser-bridge status` — read-only snapshot (#93).
   *
   * MUST NOT mutate state: no pidsfile write, no marker write, no spawn, no
   * `down` call. Read-only is the whole point — a caller asking "is the
   * bridge up?" without the question itself becoming the answer.
   *
   * Three states — see `BrowserBridgeStatusOutcome` for the taxonomy. The
   * `up-but-socket-dead` case is why this verb exists: #94's exact scenario
   * (pids alive, socket refuses from the VM). `status` must name it so the
   * caller can surface `down && up` as the recovery, rather than collapsing
   * it into "up" and leaving #94 reintroduced.
   *
   * Liveness is derived from the CURRENT state, not the pidsfile's existence
   * — a pidfile under `<xdg>/` outlives the Chrome it describes, so "up
   * because the file exists" would flip to the opposite of the truth after
   * Chrome quits. Same pattern + motivation as #90's fetcher check: kill -0
   * plus a cmdline match. Chrome and the forwarder have distinct expected
   * cmdlines (the chrome binary path and `python3 <forward.py>` respectively),
   * so we check each pid against its slot's expected string.
   */
  async status(projectId: string): Promise<BrowserBridgeStatusOutcome> {
    const chromeBin = this.deps.env["DRIDOCK_CHROME"]
      ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const port = this.envOr("DRIDOCK_CDP_PORT", "9223");
    const bind = this.envOr("DRIDOCK_CDP_BIND", "192.168.64.1");
    const url = `http://${bind}:${port}`;

    const home = await stateHome(this.deps.fs, this.deps.env, this.deps.home, "cdp");
    const pidsFile = `${home}/pids`;
    const forwardPy = `${home}/forward.py`;

    const markerPath = await this.markerFor(projectId);
    const markerContents = await this.deps.fs.readTextOrUndefined(markerPath);
    const markerExists = markerContents !== undefined;
    const markerUrl = markerContents?.trim();

    const pidsFileExists = await this.deps.fs.exists(pidsFile);
    if (!pidsFileExists) {
      return {
        kind: "down",
        bind, port, url,
        pidsFilePath: pidsFile, pidsFileExists: false, pids: [],
        projectId, markerPath, markerExists, markerUrl,
      };
    }

    // `up` writes `<chromePid> <forwarderPid>` in that order. The expected
    // cmdline for each slot is what spawnDetached was invoked with — chrome
    // binary path for the Chrome slot, `python3 <forwardPy>` for the
    // forwarder slot. Both cmdlines are unlikely to collide with unrelated
    // processes the kernel happens to assign the same pid to post-restart,
    // which is the #90-style wraparound hazard this check closes.
    const priorPids = await this.readPids(pidsFile);
    const expectedCmdlines = [chromeBin, `python3 ${forwardPy}`];
    const probe = this.deps.processProbe ?? new RealProcessProbe();

    const pidsDetail = await Promise.all(priorPids.map(async (pid, i) => {
      const alive = await this.deps.processes.isAlive(pid);
      const expected = expectedCmdlines[i] ?? "";
      let cmdlineMatches: boolean | undefined = undefined;
      if (alive && expected !== "") {
        const cmdline = probe.getCommandLine(pid);
        cmdlineMatches = cmdline === undefined ? undefined : cmdline.includes(expected);
      }
      return { pid, alive, cmdlineMatches, expectedCmdline: expected };
    }));

    // Healthy iff EVERY slot is alive AND its cmdline matches. An undefined
    // cmdlineMatches (couldn't read /proc or `ps`) is treated as NOT healthy
    // — refuse to claim "up" on missing evidence, same discipline as #90.
    const bothSlotsHealthy = pidsDetail.length === 2
      && pidsDetail.every((p) => p.alive && p.cmdlineMatches === true);

    if (!bothSlotsHealthy) {
      return {
        kind: "down",
        bind, port, url,
        pidsFilePath: pidsFile, pidsFileExists: true, pids: pidsDetail,
        projectId, markerPath, markerExists, markerUrl,
      };
    }

    // Pids healthy — now does the socket answer? Single probe (no retries):
    // this is a snapshot, not an attempt. `cdpProbe` is the #94 primitive;
    // reuse removes the "status attempts a raw CDP connect that might create
    // a target" side-effect hazard Arfy flagged in the #93 filing.
    const cdpProbeFn = this.deps.cdpProbe ?? defaultCdpProbe;
    const socketOk = await cdpProbeFn(`${url}/json/version`, 2000);

    return {
      kind: socketOk ? "up-and-responding" : "up-but-socket-dead",
      bind, port, url,
      pidsFilePath: pidsFile, pidsFileExists: true, pids: pidsDetail,
      projectId, markerPath, markerExists, markerUrl,
    };
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

/**
 * Chrome `Default/Preferences` with this harness's quiet-profile keys applied
 * ON TOP of whatever is already there (#84).
 *
 * Two behaviours it must have, and they pull in different directions:
 *
 *  - `profile.exit_type=Normal` + `exited_cleanly=true` must be re-asserted on
 *    EVERY fresh spawn. `browser-bridge down` kills the pid, so Chrome records
 *    a crash on the way out and offers "Restore pages?" on the next launch.
 *    Seeding only at profile creation would fix the first run and no other.
 *  - Everything else in the file must SURVIVE. Preferences is Chrome's main
 *    config document; replacing it wholesale would reset window bounds,
 *    per-site permissions, DevTools settings and zoom levels on every restart,
 *    which is a worse bug than the bubble it fixes.
 *
 * Merging satisfies both: the keys are a default we re-apply, not a lock, and a
 * user who edits anything else keeps their edit.
 *
 * Unparseable input falls back to the minimal document. A Preferences file
 * Chrome cannot parse is already broken — Chrome would discard it itself — so
 * replacing it is the recovery, not the data loss.
 */
export function quietProfilePreferences(existing?: string): string {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the minimal document
    }
  }
  const priorProfile =
    doc["profile"] !== null && typeof doc["profile"] === "object" && !Array.isArray(doc["profile"])
      ? (doc["profile"] as Record<string, unknown>)
      : {};
  return JSON.stringify({
    ...doc,
    profile: {
      ...priorProfile,
      exit_type: "Normal",
      exited_cleanly: true,
      password_manager_enabled: false,
    },
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
  });
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

/**
 * Default CDP probe: GET `url` with a bounded timeout. Any non-ok response or
 * network error is treated as a probe failure (fetch throws on refused/timeout/
 * DNS; we catch and return false). Deliberately swallows the error class —
 * callers only need the boolean to decide retry vs give-up (#94).
 */
async function defaultCdpProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.substring(0, i);
}

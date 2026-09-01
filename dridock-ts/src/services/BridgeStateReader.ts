import type { FileSystem } from "../infra/FileSystem.ts";
import type { ProcessProbe } from "../infra/ProcessProbe.ts";
import { xdgRoot } from "../domain/paths.ts";
import { HOST_AGENT_DEFAULT_BIND, HOST_AGENT_DEFAULT_PORT } from "./HostAgentService.ts";

/**
 * Read the OPT-IN state of the two on-Mac bridges (CDP + host-agent) so
 * StartCommand can inject their URLs/tokens into the claudebot. Ports
 * the wrapper.sh reads at :2831-2839 (CDP) and :2855-2865 (host-agent).
 *
 * Each bridge is "up" iff its state files exist; "down" is the empty
 * sidecar (matches bash's "always write, even empty, so a stale prior-
 * run sidecar doesn't survive" invariant).
 */
export class BridgeStateReader {
  constructor(
    private readonly fs: FileSystem,
    private readonly env: Record<string, string | undefined>,
    private readonly home: string,
    private readonly probe: ProcessProbe,
  ) {}

  /**
   * The CDP-URL for this project, or empty if the bridge is down.
   * Ports cb_cdp_marker(id) = `<xdg>/projects/<id>/.cdp-url`.
   */
  async cdpUrl(projectId: string): Promise<string> {
    const xdg = await xdgRoot(this.fs, this.env, this.home);
    const marker = `${xdg}/projects/${projectId}/.cdp-url`;
    return (await this.fs.readTextOrUndefined(marker))?.trim() ?? "";
  }

  /**
   * Host-agent URL + token, or empty if the daemon isn't running. Ports
   * wrapper.sh:2855 — checks pid file exists AND process is alive AND
   * token file exists.
   *
   * URL is composed from DRIDOCK_HOST_AGENT_BIND + DRIDOCK_HOST_AGENT_PORT
   * env, using the SAME defaults HostAgentService spawns with. Re-deriving
   * them here is what let 8790 (a bash-era value) persist against the real
   * 9280 — the port is now imported, not retyped.
   */
  async hostAgentState(): Promise<{ readonly url: string; readonly token: string }> {
    const xdg = await xdgRoot(this.fs, this.env, this.home);
    const home = `${xdg}/host-agent`;
    const pidRaw = await this.fs.readTextOrUndefined(`${home}/pid`);
    const token = (await this.fs.readTextOrUndefined(`${home}/token`))?.trim() ?? "";
    if (pidRaw === undefined || token === "") return { url: "", token: "" };
    const pid = Number(pidRaw.trim());
    if (!Number.isFinite(pid) || pid <= 0) return { url: "", token: "" };
    if (!(await this.probe.processAlive(pid))) return { url: "", token: "" };
    const bind = this.env["DRIDOCK_HOST_AGENT_BIND"] ?? HOST_AGENT_DEFAULT_BIND;
    const port = this.env["DRIDOCK_HOST_AGENT_PORT"] ?? HOST_AGENT_DEFAULT_PORT;
    return { url: `${bind}:${port}`, token };
  }
}

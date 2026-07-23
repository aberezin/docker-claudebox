import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { Verb } from "../../domain/Verbs.ts";

/**
 * Transparent internal delegation to the bash wrapper — per Alan's
 * ruling 2026-07-23 on the P4e scope question (see
 * project_ts_browserbridge_hostagent_full_port_todo memory).
 *
 * Zero user-visible fallback text; behavior identical to bash. Locates
 * the bash wrapper via:
 *   1. DRIDOCK_BASH_WRAPPER env var (explicit path)
 *   2. sibling `wrapper.sh` alongside the dridock-ts binary
 *   3. `dridock-bash` on PATH
 *   4. explicit error to stderr (no other option — refuse to guess)
 *
 * Used for browser-bridge + host-agent — the Python daemons
 * (browser-bridge.py, host-agent.py) are unchanged; ONLY the bash
 * orchestration layer around them is being delegated. See the
 * ts-browserbridge-hostagent-full-port-todo memory for the eventual
 * full-TS port.
 */
export class BashDelegateCommand implements Command {
  constructor(public readonly verb: Verb) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const bashWrapper = await this.resolveBashWrapper();
    if (bashWrapper === undefined) {
      ctx.stderr.write(`❌ ${ctx.binName} ${this.verb}: bash wrapper not found.\n`);
      ctx.stderr.write(`   This verb's orchestration currently lives in the bash wrapper.\n`);
      ctx.stderr.write(`   Point DRIDOCK_BASH_WRAPPER at the wrapper.sh path (or install it as 'dridock-bash' on your PATH).\n`);
      ctx.stderr.write(`   Install both together: DRIDOCK_INSTALL_TS=1 ./install.sh — the shim writes the env var.\n`);
      return 127;
    }
    // Exec the bash wrapper with the same args the user passed. Stdio
    // inherited so interactive verbs (browser-bridge's Chrome-visible
    // path) work identically to invoking the bash wrapper directly.
    const proc = Bun.spawn(["bash", bashWrapper, this.verb, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  }

  private async resolveBashWrapper(): Promise<string | undefined> {
    // 1. Env var
    const envPath = process.env["DRIDOCK_BASH_WRAPPER"];
    if (envPath !== undefined && envPath !== "") {
      if (await Bun.file(envPath).exists()) return envPath;
    }
    // 2. sibling wrapper.sh alongside the TS binary
    const argv0 = process.argv[0];
    if (argv0 !== undefined) {
      const dir = argv0.split("/").slice(0, -1).join("/");
      const sibling = `${dir}/wrapper.sh`;
      if (await Bun.file(sibling).exists()) return sibling;
    }
    // 3. `dridock-bash` on PATH
    try {
      const proc = Bun.spawn(["command", "-v", "dridock-bash"], { stdout: "pipe", stderr: "ignore" });
      const text = (await new Response(proc.stdout).text()).trim();
      const rc = await proc.exited;
      if (rc === 0 && text !== "") return text;
    } catch { /* ignore */ }
    return undefined;
  }
}

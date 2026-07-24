import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { HostProcessManager } from "../../infra/HostProcessManager.ts";
import { RealHostProcessManager } from "../../infra/HostProcessManager.ts";
import { HostAgentService } from "../../services/HostAgentService.ts";

/**
 * `dridock host-agent up|down|status` — trusted single-operator proxy
 * that lets a harness-DEV claudebot run allowlisted colima/limactl on
 * the Mac (see docs/design/backends.md). Native TS port; no BashDelegate.
 *
 * `needsProject: false` in VerbSpec because the agent is machine-scoped,
 * not per-project. No cwd guard.
 */
export class HostAgentCommand implements Command {
  readonly verb = "host-agent" as const;

  constructor(private readonly deps: Partial<HostAgentCommandDeps> = {}) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0];
    if (sub !== "up" && sub !== "down" && sub !== "status") {
      ctx.stderr.write(`usage: ${ctx.binName} host-agent up|down|status\n`);
      ctx.stderr.write(`  Trusted single-operator proxy for allowlisted colima/limactl from a\n`);
      ctx.stderr.write(`  harness-DEV claudebot back to the Mac. Off by default; OPT-IN.\n`);
      return 1;
    }

    const svc = new HostAgentService({
      fs: ctx.fs,
      processes: this.deps.processes ?? new RealHostProcessManager(),
      env: process.env,
      home: ctx.home,
      pyCandidates: this.deps.pyCandidates ?? this.defaultPyCandidates(),
      sleep: this.deps.sleep,
      randomHex: this.deps.randomHex,
    });

    if (sub === "up") return await this.runUp(svc, ctx);
    if (sub === "down") return await this.runDown(svc, ctx);
    return await this.runStatus(svc, ctx);
  }

  private async runUp(svc: HostAgentService, ctx: Context): Promise<number> {
    const outcome = await svc.up();
    switch (outcome.kind) {
      case "already-up":
        ctx.stdout.write(`🛰  host agent already up (${outcome.bind}:${outcome.port})\n`);
        return 0;
      case "py-not-found":
        ctx.stderr.write(`❌ host-agent.py not found (set DRIDOCK_HOST_AGENT_PY, or reinstall)\n`);
        ctx.stderr.write(`   searched: ${outcome.candidates.filter((p) => p !== "").join(", ")}\n`);
        return 1;
      case "spawn-failed":
        ctx.stderr.write(`❌ host agent failed to start — see ${outcome.logPath}\n`);
        if (outcome.logTail !== "") ctx.stderr.write(`${outcome.logTail}\n`);
        return 1;
      case "up":
        ctx.stdout.write(`🛰  host agent up on ${outcome.bind}:${outcome.port} (allowlisted colima/limactl)\n`);
        ctx.stdout.write(`   ⚠️  this lets a claudebot run allowlisted colima/limactl ON YOUR MAC — trusted harness dev only.\n`);
        ctx.stdout.write(`   restart your dev claudebot to pick up the agent; stop:  ${ctx.binName} host-agent down\n`);
        return 0;
    }
  }

  private async runDown(svc: HostAgentService, ctx: Context): Promise<number> {
    await svc.down();
    ctx.stdout.write(`🛰  host agent down\n`);
    return 0;
  }

  private async runStatus(svc: HostAgentService, ctx: Context): Promise<number> {
    const st = await svc.status();
    if (st.running) {
      ctx.stdout.write(`host agent: UP (${st.bind}:${st.port}, pid ${st.pid})\n`);
    } else {
      ctx.stdout.write(`host agent: down (enable with '${ctx.binName} host-agent up')\n`);
    }
    return 0;
  }

  /**
   * Ports cb_host_agent_py at wrapper.sh:1682. Resolution order:
   *   1. DRIDOCK_HOST_AGENT_PY env
   *   2. sibling of the invoked binary (dirname(argv[0])/host-agent.py)
   *   3. `<share>/claudebox/host-agent.py` (install.sh's install target
   *      when in a non-standard prefix — matches bash's fallback)
   */
  private defaultPyCandidates(): readonly string[] {
    const cands: string[] = [];
    const envOverride = process.env["DRIDOCK_HOST_AGENT_PY"];
    if (envOverride !== undefined && envOverride !== "") cands.push(envOverride);
    const argv0 = process.argv[0];
    if (argv0 !== undefined && argv0 !== "") {
      const dir = argv0.substring(0, argv0.lastIndexOf("/"));
      if (dir !== "") {
        cands.push(`${dir}/host-agent.py`);
        cands.push(`${dir}/../share/claudebox/host-agent.py`);
      }
    }
    return cands;
  }
}

export interface HostAgentCommandDeps {
  readonly processes: HostProcessManager;
  /** Test-supplied candidate paths for host-agent.py (bypasses argv[0]-based
   *  resolution which is unstable under `bun test`). */
  readonly pyCandidates: readonly string[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomHex?: (byteCount: number) => string;
}

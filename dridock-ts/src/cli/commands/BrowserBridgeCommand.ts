import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { HostProcessManager } from "../../infra/HostProcessManager.ts";
import { RealHostProcessManager } from "../../infra/HostProcessManager.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { BrowserBridgeService } from "../../services/BrowserBridgeService.ts";

/**
 * `dridock browser-bridge up|down` — opt-in CDP bridge from a claudebot
 * to the human's real Chrome. Native TS port (2026-07-24) of the
 * bash orchestration at wrapper.sh:1592-1670; no more BashDelegate.
 * Python TCP forwarder script is written to disk unchanged (bash-parity).
 */
export class BrowserBridgeCommand implements Command {
  readonly verb = "browser-bridge" as const;

  constructor(
    private readonly deps: Partial<BrowserBridgeCommandDeps> = {},
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0];
    if (sub !== "up" && sub !== "down") {
      ctx.stderr.write(`usage: ${ctx.binName} browser-bridge up|down  (opt-in: let claudebot drive your real Chrome via CDP)\n`);
      return 1;
    }

    const git = this.deps.git ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectId = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (projectId === undefined) {
      ctx.stderr.write(`❌ browser-bridge: no dridock project here (${project.dotName}/config.yml missing).\n`);
      ctx.stderr.write(`   Run '${ctx.binName} bootstrap' first — the bridge writes a per-project CDP marker keyed on the project id.\n`);
      return 1;
    }

    const svc = new BrowserBridgeService({
      fs: ctx.fs,
      processes: this.deps.processes ?? new RealHostProcessManager(),
      env: process.env,
      home: ctx.home,
      randomHex: this.deps.randomHex,
      sleep: this.deps.sleep,
    });

    if (sub === "up") return await this.runUp(svc, projectId, ctx);
    return await this.runDown(svc, projectId, ctx);
  }

  private async runUp(svc: BrowserBridgeService, projectId: string, ctx: Context): Promise<number> {
    const out = await svc.up(projectId);
    if (out.kind === "chrome-not-found") {
      ctx.stderr.write(`❌ Chrome not found at: ${out.chromePath} (set DRIDOCK_CHROME)\n`);
      return 1;
    }
    if (out.alreadyRunning) {
      ctx.stdout.write(`🔗 CDP bridge already running\n`);
    } else {
      ctx.stdout.write(`🔗 CDP bridge up — dedicated debug Chrome window "${out.windowTitle}" is open; claudebot can drive it.\n`);
    }
    ctx.stdout.write(`   in claudebot:  cb-browser cdp <url>   (uses DRIDOCK_HOST_CDP_URL=${out.url})\n`);
    ctx.stdout.write(`   ⚠️  targets must be reachable FROM THIS MAC (VM IP or localhost) — the human's\n`);
    ctx.stdout.write(`       Chrome can't resolve cb-net container names; use shot/script for those.\n`);
    ctx.stdout.write(`   profile: ${out.profile}   (override with DRIDOCK_CDP_PROFILE)\n`);
    ctx.stdout.write(`   restart claudebot (just re-run \`${ctx.binName}\`) to pick up the bridge URL.\n`);
    ctx.stdout.write(`   stop:  ${ctx.binName} browser-bridge down\n`);
    ctx.stdout.write(`   ⚠️  this hands claudebot full control of that Chrome instance (dedicated profile).\n`);
    return 0;
  }

  private async runDown(svc: BrowserBridgeService, projectId: string, ctx: Context): Promise<number> {
    await svc.down(projectId);
    ctx.stdout.write(`🔗 CDP bridge down\n`);
    return 0;
  }
}

export interface BrowserBridgeCommandDeps {
  readonly git: GitToplevel;
  readonly processes: HostProcessManager;
  /** Injected in tests to skip the 2-second post-Chrome sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests for deterministic window-hash. */
  readonly randomHex?: (byteCount: number) => string;
}

// Re-exports for tests.
export { BrowserBridgeService };

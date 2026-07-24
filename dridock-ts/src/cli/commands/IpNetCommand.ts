import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { projectProfile } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig, parseNestedYaml, stripFeaturesBlock } from "../../services/ProjectConfig.ts";

/**
 * `dridock ip` — print the project VM's reachable IP. One line, scriptable.
 * Ports wrapper.sh:3050. Rc 1 if the VM has no reachable IP yet.
 */
export class IpCommand implements Command {
  readonly verb = "ip" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly gitOverride?: GitToplevel,
  ) {}

  async run(_args: readonly string[], ctx: Context): Promise<number> {
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here (.dridock/config.yml missing)\n`);
      return 1;
    }
    const colima = this.colimaOverride ?? new RealColima();
    const profile = projectProfile(id);
    const ip = await colima.waitReachable(profile);
    if (ip !== undefined && ip !== "") {
      ctx.stdout.write(`${ip}\n`);
      return 0;
    }
    ctx.stderr.write(`VM has no reachable IP yet (try again in a moment).\n`);
    return 1;
  }
}

/**
 * `dridock net [hostname]` — print the browse dashboard + optional
 * hostname setter. Ports wrapper.sh:3060. If a hostname arg is passed,
 * writes `network.hostname` to `.dridock/config.yml` and prints the
 * /etc/hosts paste-block; else just prints the current state.
 */
export class NetCommand implements Command {
  readonly verb = "net" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly gitOverride?: GitToplevel,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const cfg = new ProjectConfig(ctx.fs);
    const id = await cfg.projectId(project.configPath);
    if (id === undefined) {
      ctx.stderr.write(`no dridock project here — run '${ctx.binName} start' first to initialize\n`);
      return 1;
    }

    const requestedHostname = args[0];
    if (requestedHostname !== undefined && requestedHostname !== "") {
      const setRc = await this.setHostname(project.configPath, requestedHostname, ctx);
      if (setRc !== 0) return setRc;
    }

    const colima = this.colimaOverride ?? new RealColima();
    const profile = projectProfile(id);
    const ip = await colima.waitReachable(profile);
    if (ip === undefined || ip === "") {
      ctx.stdout.write(`🌐 VM ${profile} has no reachable IP yet (is it running? try '${ctx.binName} start').\n`);
      return 0;
    }
    ctx.stdout.write(`🌐 project VM ${profile}: ${ip}\n`);
    ctx.stdout.write(`   browse a published workload at  http://${ip}:<port>   (or http://localhost:<port>, colima-forwarded)\n`);
    const hostname = await cfg.networkHostname(project.configPath);
    if (hostname === undefined || hostname === "") {
      ctx.stdout.write(`   no network.hostname set (so no friendly name yet). To add one, run:\n`);
      ctx.stdout.write(`       ${ctx.binName} net <name>\n`);
      ctx.stdout.write(`   — that sets it, then prints the /etc/hosts entry.\n`);
      return 0;
    }
    ctx.stdout.write(`   add to /etc/hosts (dridock won't edit it — one-time, your call):\n`);
    ctx.stdout.write(`       echo "${ip}  ${hostname}" | sudo tee -a /etc/hosts\n`);
    return 0;
  }

  private async setHostname(configPath: string, name: string, ctx: Context): Promise<number> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new DridockError(`invalid hostname '${name}' (letters, digits, '.', '-', '_' only)`);
    }
    const text = await ctx.fs.readTextOrUndefined(configPath);
    if (text === undefined) {
      ctx.stderr.write(`no config.yml at ${configPath}\n`);
      return 1;
    }
    // Rebuild config with the hostname line replaced or appended. Strip
    // any existing `network:` block first — matches bash's sed
    // pattern-then-append shape at :1470-1476.
    const stripped = stripNetworkBlock(text);
    const trimmed = stripped.replace(/\n+$/, "");
    const rebuilt = `${trimmed}\nnetwork:\n  hostname: ${name}\n`;
    await ctx.fs.writeTextAtomic(configPath, rebuilt);
    ctx.stdout.write(`  ✓ set network.hostname: ${name}   (${configPath})\n`);
    // Suppress unused: parseNestedYaml + stripFeaturesBlock are for future use.
    void parseNestedYaml; void stripFeaturesBlock;
    return 0;
  }
}

/** Remove any existing top-level `network:` block from a YAML doc. */
function stripNetworkBlock(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^network:\s*(?:#.*)?$/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^\s/.test(line)) continue; // indented child of network:
      skipping = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

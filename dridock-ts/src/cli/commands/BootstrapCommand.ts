import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { HostCommandRunner } from "../../infra/HostCommandRunner.ts";
import { RealHostCommandRunner } from "../../infra/HostCommandRunner.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import { BootstrapService } from "../../services/BootstrapService.ts";

/**
 * `dridock bootstrap` — scaffold a new claudebot project + write the mission
 * brief. Ports wrapper.sh:2574 dispatch + cb_bootstrap at :1877 + the
 * post-scaffolding flags (secrets/multi-repo/adopt clone).
 *
 * Full flag surface:
 *   --adopt [<url>]              adopt existing repo, or clone-then-adopt
 *   --workspace / --multi-repo   multi-repo orchestration parent
 *   --repo <url>                 clone repo as gitignored sibling (repeatable)
 *   --brief-only                 skip file-scaffolding, just write BRIEF.md
 *   --no-start                   don't `dridock start` after (default WOULD)
 *   --brief-file <F>             read intent from F instead of arg/stdin
 *   --secrets-file <F>           merge KEY=VALUE lines from F into secrets.env
 *   --seed-secret KEY=CMD        run CMD, store stdout as KEY (repeatable)
 *   --gh-token                   deprecated alias for --seed-secret
 *   --force                      overwrite existing BRIEF.md
 *
 * `--no-start` default is 1 (don't auto-launch); bash's default IS to
 * launch. That's a deliberate TS opinion — bootstrap is a one-shot; the
 * subsequent `dridock start` is a separate invocation the user chooses.
 * (Bash-parity for the auto-launch would require calling start's Command
 * inline, which introduces a big surface for a subtle default.)
 */
export class BootstrapCommand implements Command {
  readonly verb = "bootstrap" as const;

  constructor(
    private readonly hostOverride?: HostCommandRunner,
    private readonly readStdinFn: () => Promise<string> = defaultReadStdin,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const parsed = this.parseArgs(args, ctx);
    if (parsed === undefined) return 1;   // usage printed already
    if (parsed.adopt && parsed.workspace) {
      throw new DridockError(`bootstrap: --adopt and --workspace are mutually exclusive.`);
    }
    let intent = parsed.intent;
    if (parsed.briefFile !== undefined) {
      const text = await ctx.fs.readTextOrUndefined(parsed.briefFile);
      if (text === undefined) {
        ctx.stderr.write(`bootstrap: --brief-file not found: ${parsed.briefFile}\n`);
        return 1;
      }
      intent = text;
    } else if (intent === "") {
      intent = await this.readStdinFn();
    }

    const host = this.hostOverride ?? new RealHostCommandRunner();

    // --adopt <url> clone-then-adopt
    if (parsed.adoptUrl !== undefined) {
      const cloneRc = await this.cloneAdoptInto(host, ctx.cwd, parsed.adoptUrl, ctx);
      if (cloneRc !== 0) return cloneRc;
    } else if (parsed.adopt && !(await ctx.fs.isDirectory(`${ctx.cwd}/.git`))) {
      ctx.stderr.write(`❌ bootstrap --adopt: no git repo in ${ctx.cwd} to adopt. Use --adopt <url> to clone one here, or run plain 'bootstrap' for a greenfield project.\n`);
      return 1;
    }

    const flavor: "adopt" | "workspace" | "greenfield" =
      parsed.adopt || parsed.adoptUrl !== undefined ? "adopt"
      : parsed.workspace ? "workspace"
      : "greenfield";

    const machine = new MachineConfig(ctx.fs, process.env, ctx.home);
    const svc = new BootstrapService({
      fs: ctx.fs, host, machine, home: ctx.home,
      onNotice: (m) => ctx.stdout.write(m),
      onWarn: (m) => ctx.stderr.write(m),
    });
    const outcome = await svc.run({
      root: ctx.cwd,
      flavor,
      mode: parsed.briefOnly ? "brief-only" : "full",
      force: parsed.force,
      intent,
    });
    if (outcome.kind === "brief-exists") {
      ctx.stderr.write(`❌ .dridock/BRIEF.md already exists — use --force to overwrite\n`);
      return 1;
    }

    // Multi-repo: gitignore parent's machine-local files + clone --repo siblings
    if (parsed.workspace) {
      const clonesRc = await this.cloneSiblings(host, ctx.cwd, parsed.repos, ctx);
      if (clonesRc !== 0) return clonesRc;
    }

    // Secrets — --seed-secret runs + --secrets-file merges
    if (parsed.seedSecrets.length > 0 || parsed.secretsFile !== undefined) {
      const secretsPath = `${ctx.cwd}/.dridock/secrets.env`;
      const lines: string[] = [];
      const existing = (await ctx.fs.readTextOrUndefined(secretsPath)) ?? "";
      lines.push(...existing.split(/\r?\n/).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)));

      if (parsed.secretsFile !== undefined) {
        const merge = await ctx.fs.readTextOrUndefined(parsed.secretsFile);
        if (merge === undefined) {
          ctx.stderr.write(`bootstrap: --secrets-file not found: ${parsed.secretsFile}\n`);
          return 1;
        }
        for (const l of merge.split(/\r?\n/)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(l)) lines.push(l);
        }
      }
      for (const seed of parsed.seedSecrets) {
        const eqIdx = seed.indexOf("=");
        const key = seed.slice(0, eqIdx);
        const cmd = seed.slice(eqIdx + 1);
        const captured = await host.runCapture(cmd);
        if (captured.rc !== 0) {
          ctx.stderr.write(`  ⚠ seed-secret ${key}: command failed rc ${captured.rc} — skipped\n`);
          continue;
        }
        const value = captured.stdout.trim();
        if (value === "") {
          ctx.stderr.write(`  ⚠ seed-secret ${key}: command produced empty output — skipped\n`);
          continue;
        }
        lines.push(`${key}=${value}`);
        ctx.stdout.write(`  ✓ seeded ${key} (from '${cmd}')\n`);
      }
      // Dedupe by key — later occurrences win (matches bash's append shape).
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const l of [...lines].reverse()) {
        const eqIdx = l.indexOf("=");
        const key = l.slice(0, eqIdx);
        if (!seen.has(key)) { kept.unshift(l); seen.add(key); }
      }
      await ctx.fs.writeTextAtomic(secretsPath, kept.join("\n") + "\n", { mode: 0o600 });
      ctx.stdout.write(`  ✓ .dridock/secrets.env (${kept.length} key(s), chmod 600, gitignored)\n`);
    }

    const banner = parsed.adopt || parsed.adoptUrl !== undefined
      ? `🚀 adopted: ${basename(ctx.cwd)}`
      : parsed.workspace
      ? `🚀 multi-repo workspace: ${basename(ctx.cwd)}`
      : `🚀 bootstrapped: ${basename(ctx.cwd)}`;
    ctx.stdout.write(`${banner}\n`);
    return 0;
  }

  private parseArgs(args: readonly string[], ctx: Context): ParsedBootstrap | undefined {
    const out: ParsedBootstrap = {
      briefOnly: false, force: false,
      briefFile: undefined, secretsFile: undefined, adopt: false, adoptUrl: undefined,
      workspace: false, repos: [], seedSecrets: [],
      intent: "",
    };
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      switch (a) {
        case "--brief-only": out.briefOnly = true; break;
        case "--no-start":   /* default */ break;
        case "--force":      out.force = true; break;
        case "--brief-file": out.briefFile = args[++i]; break;
        case "--secrets-file": out.secretsFile = args[++i]; break;
        case "--seed-secret": {
          const kvArg = args[++i];
          if (kvArg === undefined || !kvArg.includes("=")) {
            throw new DridockError(`bootstrap: --seed-secret expects KEY=CMD, got '${kvArg ?? ""}'`);
          }
          out.seedSecrets.push(kvArg);
          break;
        }
        case "--gh-token": out.seedSecrets.push("GH_TOKEN=gh auth token"); break;
        case "--adopt": {
          out.adopt = true;
          const next = args[i + 1];
          if (next !== undefined && !next.startsWith("-") && (next.includes("://") || next.startsWith("git@") || next.endsWith(".git") || next.includes("/"))) {
            out.adoptUrl = next; i++;
          }
          break;
        }
        case "--workspace": case "--multi-repo": out.workspace = true; break;
        case "--repo": {
          out.workspace = true;
          const url = args[++i];
          if (url !== undefined) out.repos.push(url);
          break;
        }
        case "-h": case "--help":
          ctx.stdout.write(`usage: ${ctx.binName} bootstrap [--adopt [<url>]] [--brief-only] [--no-start] [--force] [--brief-file F] [--secrets-file F] [--seed-secret KEY=CMD]... [--workspace] [--repo <url>]... [--gh-token] ["intent…"]\n`);
          ctx.stdout.write(`  scaffold a claudebot project in the current directory + write .dridock/BRIEF.md.\n`);
          return undefined;
        case "--":
          i++;
          while (i < args.length) { out.intent = args[i]!; i++; }
          break;
        default:
          if (a?.startsWith("-")) {
            throw new DridockError(`bootstrap: unknown flag '${a}'`);
          }
          out.intent = a ?? "";
          break;
      }
      i++;
    }
    return out;
  }

  private async cloneAdoptInto(host: HostCommandRunner, cwd: string, url: string, ctx: Context): Promise<number> {
    // Bash tries `gh repo clone $url .` first, then `git clone $url .`. Same
    // priority preserved.
    const ghCloneCmd = `command -v gh >/dev/null 2>&1 && gh repo clone ${shellEscape(url)} ${shellEscape(cwd)} 2>/dev/null`;
    const gitCloneCmd = `git clone -q ${shellEscape(url)} ${shellEscape(cwd)}`;
    const cloneRc = await host.runCapture(ghCloneCmd);
    if (cloneRc.rc === 0) {
      ctx.stdout.write(`  ✓ cloned ${basename(url).replace(/\.git$/, "")} (repo IS the workspace root)\n`);
      return 0;
    }
    const gitRc = await host.runCapture(gitCloneCmd);
    if (gitRc.rc === 0) {
      ctx.stdout.write(`  ✓ cloned ${basename(url).replace(/\.git$/, "")} (repo IS the workspace root)\n`);
      return 0;
    }
    ctx.stderr.write(`❌ bootstrap --adopt <url>: clone failed for '${url}' (private? check 'gh auth login' / the URL)\n`);
    return 1;
  }

  private async cloneSiblings(host: HostCommandRunner, cwd: string, repos: readonly string[], ctx: Context): Promise<number> {
    // Always ensure `.gitignore` covers /.dridock/config.yml + secrets.env
    // + each cloned sibling's dir.
    const gitignorePath = `${cwd}/.gitignore`;
    const existing = (await ctx.fs.readTextOrUndefined(gitignorePath)) ?? "";
    const gilines = existing.split(/\r?\n/);
    const ensureLine = (line: string): void => {
      if (!gilines.includes(line)) gilines.push(line);
    };
    for (const line of ["/.dridock/config.yml", "/.dridock/secrets.env"]) ensureLine(line);

    if (repos.length === 0) {
      ctx.stdout.write(`  ℹ multi-repo parent ready — clone your repos as siblings (auto-gitignored), or use --repo <url>\n`);
      await ctx.fs.writeTextAtomic(gitignorePath, gilines.filter((l) => l.length > 0).join("\n") + "\n");
      return 0;
    }

    let cloned = 0;
    let failed = 0;
    for (const url of repos) {
      const name = basename(url).replace(/\.git$/, "");
      if (await ctx.fs.exists(`${cwd}/${name}`)) {
        ctx.stderr.write(`  ⚠ ${name}/ already exists — skipping clone\n`);
        cloned++;
      } else {
        ctx.stdout.write(`  ⬇ cloning ${url} → ${name}/ …\n`);
        const ghRc = await host.runCapture(`command -v gh >/dev/null 2>&1 && gh repo clone ${shellEscape(url)} ${shellEscape(`${cwd}/${name}`)} 2>/dev/null`);
        if (ghRc.rc === 0) cloned++;
        else {
          const gitRc = await host.runCapture(`git clone -q ${shellEscape(url)} ${shellEscape(`${cwd}/${name}`)}`);
          if (gitRc.rc === 0) cloned++;
          else {
            ctx.stderr.write(`  ❌ clone failed: ${url} (private? check 'gh auth login' / the URL)\n`);
            failed++;
          }
        }
      }
      ensureLine(`/${name}/`);
    }
    await ctx.fs.writeTextAtomic(gitignorePath, gilines.filter((l) => l.length > 0).join("\n") + "\n");
    ctx.stdout.write(`  ✓ ${cloned}/${repos.length} sibling repo(s) cloned + gitignored\n`);
    if (failed > 0) {
      ctx.stderr.write(`  ❌ ${failed} of ${repos.length} clone(s) failed — bootstrap partial\n`);
      return 1;
    }
    return 0;
  }
}

interface ParsedBootstrap {
  briefOnly: boolean;
  force: boolean;
  briefFile: string | undefined;
  secretsFile: string | undefined;
  adopt: boolean;
  adoptUrl: string | undefined;
  workspace: boolean;
  repos: string[];
  seedSecrets: string[];
  intent: string;
}

async function defaultReadStdin(): Promise<string> {
  try {
    if (process.stdin.isTTY) return "";
    return await new Response(Bun.stdin.stream()).text();
  } catch { return ""; }
}

function shellEscape(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

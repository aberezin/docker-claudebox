import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";

/**
 * `dridock harness <verb>` — framework-dev-only operations. Ports
 * wrapper.sh:2432. Currently one subverb:
 *   sync [--repair]  — rebuild cb-infra from the harness checkout
 *                       (i.e. `make build`). --repair auto-prunes cb-infra
 *                       build cache on BuildKit corruption + retries.
 *
 * MacOS-only (must run on the colima backend). Refuses inside a container.
 */
export interface HarnessDeps {
  readonly git: GitToplevel;
  readonly docker: Docker;
  /** Spawn make build in `root`. Injectable so tests don't shell out. */
  readonly runMakeBuild: (root: string) => Promise<{ rc: number; output: string }>;
  /** Detects whether we're inside a container (bash checks /.dockerenv). */
  readonly insideContainer: () => Promise<boolean>;
}

export class HarnessCommand implements Command {
  readonly verb = "harness" as const;

  constructor(private readonly depsOverride?: Partial<HarnessDeps>) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0];
    if (sub === undefined || sub === "") {
      ctx.stderr.write(`usage: ${ctx.binName} harness <verb>  (framework-dev only; verbs: sync [--repair])\n`);
      return 1;
    }
    if (sub === "-h" || sub === "--help") {
      ctx.stdout.write(`usage: ${ctx.binName} harness sync [--repair]\n`);
      return 0;
    }
    if (sub !== "sync") {
      throw new DridockError(`harness: unknown verb '${sub}' (verbs: sync)`);
    }
    return await this.sync(args.slice(1), ctx);
  }

  private async sync(args: readonly string[], ctx: Context): Promise<number> {
    let repair = false;
    for (const a of args) {
      switch (a) {
        case "--repair": repair = true; break;
        case "-h": case "--help":
          ctx.stdout.write(`usage: ${ctx.binName} harness sync [--repair]  (--repair: on BuildKit snapshot corruption, auto-prune cb-infra cache + retry)\n`);
          return 0;
        default:
          throw new DridockError(`dridock harness sync: unknown arg '${a}'`);
      }
    }
    const deps = await this.resolveDeps();

    // Guard 1: must be a harness fork
    const git = deps.git;
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const wrapperShPath = `${project.root}/wrapper.sh`;
    const wrapperText = await ctx.fs.readTextOrUndefined(wrapperShPath);
    const isHarness = wrapperText !== undefined && /^DRIDOCK_VERSION=|^CLAUDEBOX_VERSION=/m.test(wrapperText);
    if (!isHarness) {
      ctx.stderr.write(`❌ dridock harness sync: ${project.root} is not a dridock harness fork (no wrapper.sh with DRIDOCK_VERSION= or CLAUDEBOX_VERSION= at its root).\n`);
      ctx.stderr.write(`   This command rebuilds the cb-infra image from a harness checkout; it's meaningful only when developing the harness itself.\n`);
      return 1;
    }

    // Guard 2: must be on the Mac (colima backend) — inside a container the docker
    // daemon is the VM's own, not cb-infra.
    if (await deps.insideContainer()) {
      ctx.stderr.write(`❌ dridock harness sync: must run on the Mac (colima backend) to update cb-infra.\n`);
      ctx.stderr.write(`   From inside a container the docker backend would build on this VM's own daemon, not cb-infra.\n`);
      ctx.stderr.write(`   On your Mac:  cd ${project.root} && ${ctx.binName} harness sync\n`);
      return 1;
    }

    ctx.stdout.write(`🔨 dridock harness sync: rebuilding cb-infra image from ${project.root}…\n`);
    const first = await deps.runMakeBuild(project.root);
    if (first.rc === 0) return 0;
    if (!repair) return first.rc;

    // BuildKit corruption pattern detection
    const corruption = /failed to prepare extraction snapshot|parent snapshot .* does not exist/;
    if (!corruption.test(first.output)) {
      ctx.stderr.write(`\n❌ build failed, but not with a recognized BuildKit corruption pattern — --repair can't help here.\n`);
      ctx.stderr.write(`   Fix the underlying error and retry with '${ctx.binName} harness sync' (no --repair).\n`);
      return first.rc;
    }

    ctx.stderr.write(`\n🛠  detected BuildKit snapshotter corruption — pruning cb-infra build cache and retrying…\n`);
    await deps.docker.builderPrune(infraContext());
    ctx.stderr.write(`\n🔨 retrying build with clean cache (this will be a cold start — expect ~10-20 min)…\n`);
    const second = await deps.runMakeBuild(project.root);
    if (second.rc === 0) {
      ctx.stderr.write(`\n✅ recovered — cb-infra rebuilt from a clean cache.\n`);
      return 0;
    }
    ctx.stderr.write(`\n❌ still failing after a nuclear cache prune. Next thing to try is a colima restart:\n`);
    ctx.stderr.write(`     colima stop -p cb-infra && colima start -p cb-infra\n`);
    ctx.stderr.write(`     ${ctx.binName} harness sync   (or: make build)\n`);
    return second.rc;
  }

  private async resolveDeps(): Promise<HarnessDeps> {
    return {
      git: this.depsOverride?.git ?? new RealGitToplevel(),
      docker: this.depsOverride?.docker ?? new RealDocker(),
      runMakeBuild: this.depsOverride?.runMakeBuild ?? defaultRunMakeBuild,
      insideContainer: this.depsOverride?.insideContainer ?? defaultInsideContainer,
    };
  }
}

async function defaultRunMakeBuild(root: string): Promise<{ rc: number; output: string }> {
  try {
    // Run `make build` in root; pipe both streams so we can grep for the
    // BuildKit corruption pattern. Also tee to user's stdout so they see live output.
    const proc = Bun.spawn(["make", "-C", root, "build"], {
      stdout: "pipe", stderr: "pipe",
    });
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // Print everything to the wrapper's stdout as we go — in practice we
    // collect then dump, which is a small fidelity loss vs live-tee but
    // matches the "capture + inspect" shape better here.
    process.stdout.write(stdoutText);
    process.stderr.write(stderrText);
    const rc = await proc.exited;
    return { rc, output: stdoutText + stderrText };
  } catch {
    return { rc: 1, output: "" };
  }
}

async function defaultInsideContainer(): Promise<boolean> {
  try {
    // Bash checks /.dockerenv (created by dockerd inside every container).
    const stat = await Bun.file("/.dockerenv").exists();
    return stat;
  } catch { return false; }
}

import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { CheckVersionService, infraContext, projectContext, projectProfile, type CheckVersionOutcome, type CheckVersionInputs } from "../../services/CheckVersion.ts";
import { RealDocker, type Docker } from "../../infra/Docker.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima } from "../../infra/Colima.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";
import { Version } from "../../domain/Version.ts";

/**
 * `dridock checkversion` — host wrapper vs claudebot image drift.
 * Ports the corresponding bash case + cb_checkversion at wrapper.sh:1073.
 *
 * Phase 2 scope: single-project (this project + cb-infra). The `--all`
 * sweep of every cb-* project VM is Phase 3 (needs a Colima list adapter
 * to enumerate profiles). If the user passes `--all`, we defer with a
 * "not yet ported — use bash wrapper" rc=2 rather than silently
 * dropping the flag (that's the class the 3.3.6 audit was for).
 */
export class CheckversionCommand implements Command {
  readonly verb = "checkversion" as const;

  constructor(
    private readonly imageName = "dridock:latest",
    private readonly dockerOverride?: Docker,
    private readonly gitOverride?: GitToplevel,
    private readonly colimaOverride?: Colima,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    let all = false;
    let binaryCheck = false;
    for (const arg of args) {
      switch (arg) {
        case "--all": case "-a": all = true; break;
        case "--binary": case "-b": binaryCheck = true; break;
        case "-h": case "--help":
          ctx.stdout.write(`usage: ${ctx.binName} checkversion [--all] [--binary]\n`);
          ctx.stdout.write(`  --all    = scan every cb-* project VM in addition to cb-infra + this project\n`);
          ctx.stdout.write(`  --binary = compare THIS compiled binary's baked version against the VERSION\n`);
          ctx.stdout.write(`             file in the current source-tree checkout. Standalone diagnostic —\n`);
          ctx.stdout.write(`             doesn't touch docker or the VM.\n`);
          return 0;
        default:
          throw new DridockError(`checkversion: unknown arg '${arg}'`);
      }
    }

    const git = this.gitOverride ?? new RealGitToplevel();

    // --binary is a standalone diagnostic path — no docker calls, no VM
    // needed. Compares the binary's baked DRIDOCK_TS_VERSION against the
    // VERSION file at the repo's git toplevel. Filed by Arfy after #40
    // (her first repro was stale-binary and looked like a real bug —
    // this catches that class BEFORE it becomes an "unrepeatable" ghost).
    if (binaryCheck) {
      if (all) throw new DridockError(`checkversion: --binary and --all are mutually exclusive`);
      return await this.runBinaryCheck(ctx, git);
    }

    const docker = this.dockerOverride ?? new RealDocker();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const projectId = await new ProjectConfig(ctx.fs).projectId(project.configPath);

    const svc = new CheckVersionService(docker, this.imageName);
    const evaluation = await svc.evaluate(DRIDOCK_TS_VERSION, projectId);

    this.renderHeader(evaluation, ctx);

    if (all) {
      // Ports the `--all` branch at wrapper.sh:1105 — enumerate every
      // cb-* VM (excluding cb-infra + this project) and print each's
      // image version. Uses the extended Colima adapter.
      const colima = this.colimaOverride ?? new RealColima();
      const vms = await colima.list();
      const thisProfile = projectId !== undefined ? projectProfile(projectId) : "";
      const others = vms
        .map((v) => v.name)
        .filter((n) => n.startsWith("cb-") && n !== "cb-infra" && n !== thisProfile);
      ctx.stdout.write(`  all cb-* project VMs (--all):\n`);
      if (others.length === 0) {
        ctx.stdout.write(`    (none besides this project)\n`);
      } else {
        for (const profile of others.sort()) {
          const version = await docker.imageVersion(`colima-${profile}`, this.imageName);
          ctx.stdout.write(`    ${profile.padEnd(24)} ${version}\n`);
        }
      }
      ctx.stdout.write(`\n`);
    }

    this.renderOutcome(evaluation.outcome, ctx);
    return 0;
  }

  /**
   * `--binary` — compare the binary's baked `DRIDOCK_TS_VERSION` against
   * the `VERSION` file at the current git toplevel. Exit codes:
   *   0 → in-sync (or "not in a checkout" — informational, not an error)
   *   0 → drift found but reported cleanly (matches bash's advisory tone)
   *   1 → git toplevel found but no VERSION file (structural: caller
   *        is in a git repo that ISN'T a dridock source checkout — say so)
   *
   * The "not in a checkout" branch is deliberately rc 0 + informational
   * rather than an error — this verb is invoked opportunistically ("am I
   * running a stale binary?"), and "not in a repo" is a legitimate
   * answer, not a caller misuse.
   */
  private async runBinaryCheck(ctx: Context, git: GitToplevel): Promise<number> {
    const bakedVersion = DRIDOCK_TS_VERSION;
    ctx.stdout.write(`dridock-ts binary vs source tree:\n`);
    ctx.stdout.write(`  binary: ${bakedVersion}  (baked at build time)\n`);

    const toplevel = await git.topLevel(ctx.cwd);
    if (toplevel === undefined) {
      ctx.stdout.write(`  source: <not in a git repo — run this from a dridock checkout to compare>\n`);
      return 0;
    }
    const versionPath = `${toplevel}/VERSION`;
    const versionText = await ctx.fs.readTextOrUndefined(versionPath);
    if (versionText === undefined) {
      ctx.stdout.write(`  source: <not a dridock checkout>\n`);
      ctx.stderr.write(`❌ ${versionPath} not found. Toplevel ${toplevel} is a git repo, but not a dridock source tree — run this from a dridock checkout to compare.\n`);
      return 1;
    }
    const sourceVersion = versionText.trim();
    ctx.stdout.write(`  source: ${sourceVersion}  (from ${versionPath})\n`);

    // Compare with parseLoose so a weirdly-stamped file (leading `v`,
    // trailing whitespace/newline, `-rc1`) doesn't blow up the check —
    // same tolerance Version has everywhere else.
    const baked = Version.parseLoose(bakedVersion);
    const source = Version.parseLoose(sourceVersion);
    const cmp = baked.compareTo(source);
    if (cmp === "eq") {
      ctx.stdout.write(`✅ in sync — binary and source tree are both ${sourceVersion}.\n`);
      return 0;
    }
    if (cmp === "lt") {
      ctx.stdout.write(`⚠️  STALE binary — source tree is newer than the binary you're running.\n`);
      // One-liner (rebuild + install + codesign re-sign all in one, no stale window):
      //   `install.sh` gates the TS build+install behind DRIDOCK_INSTALL_TS=1
      //   (see install.sh:128) — plain `./install.sh` alone will NOT rebuild
      //   TS-side, keeping the stale binary in place. Spelling out a manual
      //   `bun build …` would drift from `package.json`'s canonical flags
      //   (missing --minify/--sourcemap) AND skip the #41 codesign re-sign
      //   install.sh does after the copy — so we point at the canonical path.
      //   Caught by Arfy on #41 verify (2026-07-24).
      ctx.stdout.write(`    Rebuild + reinstall (one step):  DRIDOCK_INSTALL_TS=1 ./install.sh\n`);
    } else {
      // baked > source: binary was built off a newer checkout than the
      // one currently on disk. Rare (e.g. after `git checkout` to an
      // older ref without rebuilding), but call it out — the binary's
      // behavior may not match the source you're reading.
      ctx.stdout.write(`ℹ️  binary is NEWER than source — the checkout you're in is behind the compiled binary.\n`);
      ctx.stdout.write(`    Common cause: 'git checkout <older-ref>' without rebuilding the binary.\n`);
    }
    return 0;
  }

  private renderHeader(e: CheckVersionInputs, ctx: Context): void {
    ctx.stdout.write(`dridock versions:\n`);
    ctx.stdout.write(`  wrapper (host):        ${e.wrapperVersion}\n`);
    ctx.stdout.write(`  image (cb-infra):      ${e.infraImageVersion}\n`);
    if (e.projectId !== undefined) {
      ctx.stdout.write(`  image (this project):  ${e.projectImageVersion ?? "?"}   (VM ${projectProfile(e.projectId)})\n`);
      // Bash-parity: the claude CLI in the image is a separate axis from
      // the harness semver. Show "unavailable" when it's not queryable
      // (VM down / image absent) — matches wrapper.sh:1093. Arfy #38 §🟠
      // caught this row missing.
      ctx.stdout.write(`  claude CLI (in image): ${e.claudeCliVersion ?? "unavailable"}\n`);
    } else {
      ctx.stdout.write(`  image (this project):  <no dridock project in ${ctx.cwd}>\n`);
    }
    ctx.stdout.write(`\n`);
  }

  private renderOutcome(o: CheckVersionOutcome, ctx: Context): void {
    switch (o.kind) {
      case "in-sync":
        ctx.stdout.write(`✅ in sync — wrapper and claudebot image are both ${o.version}.\n`);
        return;
      case "reseed-needed":
        ctx.stdout.write(`ℹ️  cb-infra is current (${o.infraVersion}); this project's VM still runs ${o.projectVersion}.\n`);
        ctx.stdout.write(`   → run '${ctx.binName} start' in this project — it auto-reseeds ${o.infraVersion} and recreates the container\n`);
        ctx.stdout.write(`     (session preserved). No rebuild needed.\n`);
        return;
      case "no-comparable":
        if (o.reason === "predates-versioning") {
          ctx.stdout.write(`ℹ️  the claudebot image predates versioning (no stamp). Rebuild to stamp it: make build\n`);
        } else {
          ctx.stdout.write(`ℹ️  no built image reachable to compare (VMs down / not built yet): make build\n`);
        }
        return;
      case "drift":
        ctx.stdout.write(`⚠️  version drift: wrapper ${o.wrapperVersion} vs claudebot image ${o.imageVersion}.\n`);
        switch (o.severity) {
          case "major": ctx.stdout.write(`   🔴 MAJOR drift — rebuild/update REQUIRED (breaking IPC-contract change; peers may be incompatible).\n`); break;
          case "minor": ctx.stdout.write(`   🟠 MINOR drift — you SHOULD rebuild/update (new features / additive contract change; still compatible).\n`); break;
          case "patch": ctx.stdout.write(`   🟡 PATCH drift — rebuild OPTIONAL (fixes/docs only, no contract change).\n`); break;
          case "same":  break; // Shouldn't occur — drift implies wv != cmp
        }
        switch (o.direction) {
          case "wrapper-newer": ctx.stdout.write(`      host wrapper is newer → rebuild the image, then restart:  make build\n`); break;
          case "image-newer":   ctx.stdout.write(`      claudebot image is newer → update the host wrapper:  ./install.sh\n`); break;
        }
        return;
    }
  }
}

// Re-export for tests that need the same context helpers.
export { infraContext, projectContext };

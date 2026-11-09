import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";
import type { Docker } from "../../infra/Docker.ts";
import { RealDocker, infraContext } from "../../infra/Docker.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { Version } from "../../domain/Version.ts";
import { CLAUDE_CLI_REMOTE_CONTROL_FLOOR } from "../../domain/dridockVersion.ts";

/**
 * `dridock harness <verb>` — framework-dev-only operations. Ports
 * wrapper.sh:2432. Two subverbs:
 *   sync [--repair]            — rebuild cb-infra from the harness checkout
 *                                (i.e. `make build`). --repair auto-prunes
 *                                cb-infra build cache on BuildKit corruption
 *                                + retries.
 *   update-cli <v|latest|stable> [--skip-build]
 *                              — raise the baked Claude CLI pin + the repo's
 *                                own version in lockstep (#100).
 *
 * `sync` is MacOS-only (must run on the colima backend) and refuses inside a
 * container. `update-cli` has no such guard — it only edits live-mounted
 * files, and its optional validation build auto-selects backend the same
 * way `make build-minimal` always does.
 */
export interface HarnessDeps {
  readonly git: GitToplevel;
  readonly docker: Docker;
  /** Spawn make build in `root`. Injectable so tests don't shell out. */
  readonly runMakeBuild: (root: string) => Promise<{ rc: number; output: string }>;
  /** Detects whether we're inside a container (bash checks /.dockerenv). */
  readonly insideContainer: () => Promise<boolean>;
  /** Spawn `make build-minimal` in `root` (#100's validation step). Separate
   *  from runMakeBuild (full image) so update-cli's default validation stays
   *  fast; tests inject their own. */
  readonly runMakeBuildMinimal: (root: string) => Promise<{ rc: number; output: string }>;
  /** Read the Claude CLI version baked into an already-built image, by
   *  running `claude --version` inside it. `dockerArgs` is whatever must
   *  precede `run` to reach the SAME daemon `make` just built into — e.g.
   *  `["--context", "colima-cb-infra"]` on the colima backend, `[]` bare on
   *  the docker backend. The command computes `dockerArgs`; this just runs
   *  what it's told, so the context-selection logic stays testable without
   *  a real docker daemon (Arfy's F1 on #100: a bare `docker run` silently
   *  queries whatever the OPERATOR's ambient context happens to be, which
   *  only coincidentally matched cb-infra in-container — on the Mac it can
   *  be a completely different daemon, so the read-back returns undefined
   *  and the command misreports a stale-cache build failure that never
   *  happened). Mirrors #94's cdpProbe shape: a plain async function dep,
   *  not a new infra class, for a single external call. */
  readonly readBakedClaudeVersion: (image: string, dockerArgs: readonly string[]) => Promise<string | undefined>;
  /** Resolve a named release channel (`latest`/`stable`) to a concrete
   *  version string via `${releasesUrl}/${channel}`. Default impl is a real
   *  `fetch`; tests inject a fixture. Mirrors install.sh's own curl-based
   *  resolution — kept here too because install.sh is a bootstrap script
   *  that must work before dridock-ts exists, so it can't call into this. */
  readonly resolveChannel: (channel: string, releasesUrl: string) => Promise<string | undefined>;
}

export class HarnessCommand implements Command {
  readonly verb = "harness" as const;
  readonly usage = `dridock harness <subverb>

Harness-dev mode commands for working on dridock itself. See
'dridock harness <subverb> --help' for each (sync, update-cli).`;

  // Declared so the usage text and the dispatcher above cannot drift apart
  // (#60's lesson, re-caught for this verb while adding update-cli): until
  // now `harness` had one subverb and no `subverbs` array, so
  // UsageSubverbs.test.ts / HelpConformance.test.ts — both driven off the
  // real registry — silently skipped it. Declaring it here is what makes
  // those tests see this verb at all.
  readonly subverbs = [
    {
      name: "sync",
      synopsis: `dridock harness sync [--repair]

Rebuild cb-infra from this harness checkout (i.e. 'make build'). MacOS-only
(colima backend) — refuses inside a container. --repair auto-prunes cb-infra
build cache on BuildKit snapshotter corruption and retries once.`,
    },
    {
      name: "update-cli",
      synopsis: `dridock harness update-cli <version|latest|stable> [--skip-build] [--allow-downgrade]

Raise the baked Claude CLI pin (Dockerfile's ARG CLAUDE_VERSION) and this
repo's own VERSION + dridockVersion.ts in lockstep, then validate by
building and reading the version back out of the image. --skip-build writes
the pin without validating it. Refuses a downgrade from the CURRENT pin
unless --allow-downgrade is passed (the --remote-control floor is a
different, lower bar — 'stable' resolving below an already-newer 'latest'
pin is a real case this guards, not a hypothetical). Never commits.`,
    },
  ] as const;

  constructor(private readonly depsOverride?: Partial<HarnessDeps>) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0];
    if (sub === undefined || sub === "") {
      ctx.stderr.write(`usage: ${ctx.binName} harness <verb>  (framework-dev only; verbs: sync [--repair], update-cli <v|latest|stable> [--skip-build] [--allow-downgrade])\n`);
      return 1;
    }
    if (sub === "-h" || sub === "--help") {
      ctx.stdout.write(`usage: ${ctx.binName} harness sync [--repair]\n`);
      ctx.stdout.write(`       ${ctx.binName} harness update-cli <version|latest|stable> [--skip-build] [--allow-downgrade]\n`);
      return 0;
    }
    if (sub === "update-cli") return await this.updateCli(args.slice(1), ctx);
    if (sub !== "sync") {
      throw new DridockError(`harness: unknown verb '${sub}' (verbs: sync, update-cli)`);
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
    // Fingerprint the fork by a file that actually exists. Until 5.0 this
    // grepped `wrapper.sh` for DRIDOCK_VERSION= — but wrapper.sh was RETIRED in
    // 4.0.0, so the guard could not recognise the harness repo itself and
    // `dridock harness sync` had been dead since then, in the one place it is
    // meant to run. entrypoint.sh:592 already switched to this fingerprint and
    // says so ("replaces the pre-4.0.0 wrapper.sh + grep check that broke when
    // wrapper.sh was deleted"); this call site was simply missed.
    const fingerprint = `${project.root}/dridock-ts/src/domain/dridockVersion.ts`;
    const isHarness = await ctx.fs.exists(fingerprint);
    if (!isHarness) {
      ctx.stderr.write(`❌ dridock harness sync: ${project.root} is not a dridock harness fork (no dridock-ts/src/domain/dridockVersion.ts at its root).\n`);
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

  /**
   * `dridock harness update-cli <version|latest|stable> [--skip-build]` (#100).
   *
   * Does the five-step manual bump (done by hand for #89/5.11.0) in one
   * verb: resolve the target, guard the --remote-control floor, write the
   * Dockerfile pin + VERSION + dridockVersion.ts + a CHANGELOG entry in
   * lockstep, then validate by building and reading the ACTUAL baked
   * version back out of the image — never trust a green `make` exit alone,
   * a cached layer can silently reuse the old npm install.
   *
   * Never commits. Same convention as `dridock plugins add` / `features
   * enable`: this edits tracked files and leaves `git add` + commit to the
   * operator.
   */
  private async updateCli(args: readonly string[], ctx: Context): Promise<number> {
    let target: string | undefined;
    let skipBuild = false;
    let allowDowngrade = false;
    for (const a of args) {
      if (a === "--skip-build") { skipBuild = true; continue; }
      if (a === "--allow-downgrade") { allowDowngrade = true; continue; }
      if (a === "-h" || a === "--help") {
        ctx.stdout.write(`usage: ${ctx.binName} harness update-cli <version|latest|stable> [--skip-build] [--allow-downgrade]\n`);
        ctx.stdout.write(`  <version>          explicit MAJOR.MINOR.PATCH, e.g. 2.1.319\n`);
        ctx.stdout.write(`  latest/stable      resolve via the official release channel at run time\n`);
        ctx.stdout.write(`  --skip-build       write the pin without validating it (default: validates via\n`);
        ctx.stdout.write(`                     'make build-minimal' and reads the baked version back out)\n`);
        ctx.stdout.write(`  --allow-downgrade  permit a target OLDER than the current pin (refused by\n`);
        ctx.stdout.write(`                     default -- e.g. 'stable' can trail an already-newer 'latest')\n`);
        return 0;
      }
      if (target !== undefined) {
        throw new DridockError(`harness update-cli: unexpected argument '${a}' (already have target '${target}')`);
      }
      target = a;
    }
    if (target === undefined) {
      ctx.stderr.write(`❌ harness update-cli: missing target (usage: ${ctx.binName} harness update-cli <version|latest|stable> [--skip-build])\n`);
      return 1;
    }

    const deps = await this.resolveDeps();

    // Guard: must be a harness fork. Same fingerprint as sync — see its
    // comment for why this checks a file's existence, not a grep.
    const git = deps.git;
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const fingerprint = `${project.root}/dridock-ts/src/domain/dridockVersion.ts`;
    const isHarness = await ctx.fs.exists(fingerprint);
    if (!isHarness) {
      ctx.stderr.write(`❌ dridock harness update-cli: ${project.root} is not a dridock harness fork (no dridock-ts/src/domain/dridockVersion.ts at its root).\n`);
      ctx.stderr.write(`   This command bumps the harness's OWN Dockerfile pin; it's meaningful only when developing the harness itself.\n`);
      return 1;
    }

    // Resolve the target version. Explicit version: validate shape, no
    // network call. Named channel: resolve via the same release-channel URL
    // install.sh already uses, overridable for tests/ops.
    let resolvedVersion: string;
    // Deliberately stricter than install.sh:56's bash regex, which also
    // accepts a prerelease suffix (`2.2.0-rc1`). Arfy flagged the divergence
    // on #100 (F5) since the issue frames this as mirroring the bash
    // resolution; this command refuses a prerelease on purpose rather than
    // writing a non-final version into a tracked Dockerfile pin.
    const SEMVER_RE = /^\d+\.\d+\.\d+$/;
    if (target === "latest" || target === "stable") {
      const releasesUrl = ctx.env.raw()["DRIDOCK_CLAUDE_RELEASES_URL"] ?? "https://downloads.claude.ai/claude-code-releases";
      const resolved = await deps.resolveChannel(target, releasesUrl);
      if (resolved === undefined || !SEMVER_RE.test(resolved)) {
        ctx.stderr.write(`❌ harness update-cli: could not resolve channel '${target}' to a version via ${releasesUrl}/${target}.\n`);
        if (resolved !== undefined) ctx.stderr.write(`   Got back '${resolved}', which isn't MAJOR.MINOR.PATCH.\n`);
        ctx.stderr.write(`   Pass an explicit version instead: ${ctx.binName} harness update-cli 2.1.319\n`);
        return 1;
      }
      resolvedVersion = resolved;
      ctx.stdout.write(`==> '${target}' resolves to ${resolvedVersion}\n`);
    } else {
      if (!SEMVER_RE.test(target)) {
        ctx.stderr.write(`❌ harness update-cli: '${target}' isn't a version (expected MAJOR.MINOR.PATCH) or 'latest'/'stable'.\n`);
        return 1;
      }
      resolvedVersion = target;
    }

    // Read the current pin. The top-of-file default is the only line this
    // command edits; the bare mid-file `ARG CLAUDE_VERSION` re-declarations
    // (multi-stage builds re-import a build arg per stage) take no value
    // and stay untouched.
    const dockerfilePath = `${project.root}/Dockerfile`;
    const dockerfileText = await ctx.fs.readTextOrUndefined(dockerfilePath);
    if (dockerfileText === undefined) {
      ctx.stderr.write(`❌ harness update-cli: no Dockerfile at ${dockerfilePath}.\n`);
      return 1;
    }
    const pinMatch = /^ARG CLAUDE_VERSION=(\S+)$/m.exec(dockerfileText);
    if (!pinMatch) {
      ctx.stderr.write(`❌ harness update-cli: no top-level 'ARG CLAUDE_VERSION=' line found in ${dockerfilePath}.\n`);
      return 1;
    }
    const currentPin = pinMatch[1]!;

    if (currentPin === resolvedVersion) {
      ctx.stdout.write(`✅ harness update-cli: already at ${resolvedVersion} — nothing to do.\n`);
      return 0;
    }

    // Floor guard: never silently regress below the --remote-control floor.
    // Same check StartCommand makes against a running image's stamped
    // version; here it runs BEFORE the pin is written.
    const targetVer = Version.parseLoose(resolvedVersion);
    const floorVer = Version.parseLoose(CLAUDE_CLI_REMOTE_CONTROL_FLOOR);
    if (targetVer.compareTo(floorVer) === "lt") {
      ctx.stderr.write(`❌ harness update-cli: refusing — ${resolvedVersion} is below the --remote-control floor (${CLAUDE_CLI_REMOTE_CONTROL_FLOOR}).\n`);
      ctx.stderr.write(`   That would silently disable Remote Control on every project built from this image (#17's failure class).\n`);
      ctx.stderr.write(`   Pass a version >= ${CLAUDE_CLI_REMOTE_CONTROL_FLOOR}, or raise the floor deliberately in dridockVersion.ts first.\n`);
      return 1;
    }

    // Downgrade guard: distinct from the floor check above. The floor is a
    // capability minimum (#17's failure class); this catches the more common
    // case of silently going BACKWARDS from whatever is already pinned —
    // concretely, 'stable' resolving behind an already-newer 'latest' pin
    // (Arfy's F2 on #100: this sailed through the floor check with a green
    // rc=0, pin went 2.1.319 -> 2.1.311, and the CHANGELOG line it wrote said
    // "raised"). Refused by default; --allow-downgrade opts in explicitly.
    const currentPinVer = Version.parseLoose(currentPin);
    const isDowngrade = targetVer.compareTo(currentPinVer) === "lt";
    if (isDowngrade && !allowDowngrade) {
      ctx.stderr.write(`❌ harness update-cli: refusing — resolved target ${resolvedVersion} is OLDER than the current pin ${currentPin}.\n`);
      ctx.stderr.write(`   '${target}' may have moved backward relative to what's already pinned, or this is a deliberate downgrade.\n`);
      ctx.stderr.write(`   Pass --allow-downgrade if this is intentional.\n`);
      return 1;
    }
    const direction = isDowngrade ? "lowered" : "raised";

    // Read + bump the repo's own version in lockstep with the CLI pin.
    const versionPath = `${project.root}/VERSION`;
    const versionText = await ctx.fs.readTextOrUndefined(versionPath);
    if (versionText === undefined) {
      ctx.stderr.write(`❌ harness update-cli: no VERSION file at ${versionPath}.\n`);
      return 1;
    }
    let currentDridockVersion: Version;
    try {
      currentDridockVersion = Version.parse(versionText);
    } catch (e) {
      ctx.stderr.write(`❌ harness update-cli: ${versionPath} doesn't parse as semver: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    const newDridockVersion = currentDridockVersion.bumpMinor();

    const dridockVersionPath = `${project.root}/dridock-ts/src/domain/dridockVersion.ts`;
    const dridockVersionText = await ctx.fs.readTextOrUndefined(dridockVersionPath);
    if (dridockVersionText === undefined) {
      ctx.stderr.write(`❌ harness update-cli: ${dridockVersionPath} is missing (but its existence is the harness fingerprint — this should be unreachable).\n`);
      return 1;
    }
    const tsVersionLineRe = /export const DRIDOCK_TS_VERSION = "[^"]*";/;
    if (!tsVersionLineRe.test(dridockVersionText)) {
      ctx.stderr.write(`❌ harness update-cli: no 'export const DRIDOCK_TS_VERSION = "...";' line found in ${dridockVersionPath}.\n`);
      return 1;
    }

    // Write all three files. No commit — matches dridock plugins add / features
    // enable, which edit tracked files and leave git to the operator.
    const newDockerfileText = dockerfileText.replace(
      /^ARG CLAUDE_VERSION=\S+$/m,
      `ARG CLAUDE_VERSION=${resolvedVersion}`,
    );
    await ctx.fs.writeText(dockerfilePath, newDockerfileText);
    await ctx.fs.writeText(versionPath, `${newDridockVersion.toString()}\n`);
    await ctx.fs.writeText(
      dridockVersionPath,
      dridockVersionText.replace(tsVersionLineRe, `export const DRIDOCK_TS_VERSION = "${newDridockVersion.toString()}";`),
    );

    const changelogPath = `${project.root}/CHANGELOG.md`;
    const changelogText = await ctx.fs.readTextOrUndefined(changelogPath);
    if (changelogText !== undefined && changelogText.includes("## [Unreleased]")) {
      const today = new Date().toISOString().slice(0, 10);
      const entry = [
        `## [${newDridockVersion.toString()}] - ${today}`,
        ``,
        `### Changed`,
        `- Claude Code CLI pin ${direction} **${currentPin} → ${resolvedVersion}** (\`ARG CLAUDE_VERSION\`)${target === "latest" || target === "stable" ? `, resolved from the \`${target}\` release channel` : ""}. Above the \`--remote-control\` floor (${CLAUDE_CLI_REMOTE_CONTROL_FLOOR}).`,
        ``,
      ].join("\n");
      await ctx.fs.writeText(changelogPath, changelogText.replace("## [Unreleased]\n", `## [Unreleased]\n\n${entry}`));
    } else {
      ctx.stderr.write(`⚠️  harness update-cli: no '## [Unreleased]' anchor found in ${changelogPath} — skipped the CHANGELOG entry. Add one by hand:\n`);
      ctx.stderr.write(`   Claude Code CLI pin raised ${currentPin} → ${resolvedVersion}.\n`);
    }

    ctx.stdout.write(`✏️  harness update-cli: pin ${currentPin} → ${resolvedVersion}; dridock ${currentDridockVersion.toString()} → ${newDridockVersion.toString()}.\n`);

    if (skipBuild) {
      ctx.stdout.write(`\n⏭  --skip-build: not validating. Before relying on this, build + check:\n`);
      ctx.stdout.write(`     make build-minimal && docker run --rm --entrypoint claude dridock:latest-minimal --version\n`);
      ctx.stdout.write(`\nThis only edited local files — nothing is committed. Mac-side propagation still needed:\n`);
      ctx.stdout.write(`  1. review + commit (this command never does)\n`);
      ctx.stdout.write(`  2. on the Mac: make build (or ./install.sh) to push the real image into cb-infra\n`);
      ctx.stdout.write(`  3. on the Mac: dridock down && dridock start to recreate projects on it\n`);
      return 0;
    }

    ctx.stdout.write(`\n🔨 validating: make build-minimal…\n`);
    const built = await deps.runMakeBuildMinimal(project.root);
    if (built.rc !== 0) {
      ctx.stderr.write(`\n❌ harness update-cli: 'make build-minimal' failed (rc=${built.rc}). Files are edited; nothing reverted.\n`);
      ctx.stderr.write(`   Fix the build and re-run with --skip-build to skip straight past this check, or 'git checkout' to discard the edits.\n`);
      return built.rc;
    }

    // Read the built image back from the SAME daemon `make` just built it
    // into, and under the SAME name/tag it used — both mirror Makefile's own
    // selection logic exactly (Arfy's F1 on #100: a bare, context-less
    // `docker run` happened to work in-container, where the ambient daemon
    // IS the build daemon, but on the Mac it silently queries whatever
    // context the operator's shell happens to be on, which need not be
    // cb-infra; the read-back then returns undefined and gets misreported
    // below as a stale-cache build failure that never happened).
    const env = ctx.env.raw();
    const explicitBackend = env["DRIDOCK_BACKEND"]; // Makefile's own `?=`: an exported value wins over auto-detection, without even running it.
    const backend = explicitBackend === "docker" || explicitBackend === "colima"
      ? explicitBackend
      : (await deps.insideContainer()) ? "docker" : "colima";
    const dockerArgs = backend === "docker" ? [] : ["--context", infraContext()];
    const imageName = env["IMAGE_NAME"] ?? "dridock";
    const tag = env["TAG"] ?? "latest";
    const image = `${imageName}:${tag}-minimal`;

    const bakedVersion = await deps.readBakedClaudeVersion(image, dockerArgs);
    if (bakedVersion !== resolvedVersion) {
      ctx.stderr.write(`\n❌ harness update-cli: build succeeded, but ${image}${dockerArgs.length > 0 ? ` (docker ${dockerArgs.join(" ")})` : ""} bakes claude ${bakedVersion ?? "(unreadable)"}, not ${resolvedVersion}.\n`);
      ctx.stderr.write(`   Either a cached layer reused the old npm install (try: make build-minimal again, or 'docker builder prune'), or this read-back is reaching the wrong daemon/image — check DRIDOCK_BACKEND/IMAGE_NAME/TAG.\n`);
      ctx.stderr.write(`   Files are edited; nothing reverted.\n`);
      return 1;
    }

    ctx.stdout.write(`✅ validated — ${image} bakes claude ${bakedVersion}.\n`);
    ctx.stdout.write(`\nThis only built + edited LOCAL files — nothing is committed or propagated. Remaining steps:\n`);
    ctx.stdout.write(`  1. review + commit (this command never does)\n`);
    ctx.stdout.write(`  2. on the Mac: make build (or ./install.sh) to push the real image into cb-infra\n`);
    ctx.stdout.write(`  3. on the Mac: dridock down && dridock start to recreate projects on it\n`);
    return 0;
  }

  private async resolveDeps(): Promise<HarnessDeps> {
    return {
      git: this.depsOverride?.git ?? new RealGitToplevel(),
      docker: this.depsOverride?.docker ?? new RealDocker(),
      runMakeBuild: this.depsOverride?.runMakeBuild ?? defaultRunMakeBuild,
      insideContainer: this.depsOverride?.insideContainer ?? defaultInsideContainer,
      runMakeBuildMinimal: this.depsOverride?.runMakeBuildMinimal ?? defaultRunMakeBuildMinimal,
      readBakedClaudeVersion: this.depsOverride?.readBakedClaudeVersion ?? defaultReadBakedClaudeVersion,
      resolveChannel: this.depsOverride?.resolveChannel ?? defaultResolveChannel,
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

async function defaultRunMakeBuildMinimal(root: string): Promise<{ rc: number; output: string }> {
  try {
    const proc = Bun.spawn(["make", "-C", root, "build-minimal"], {
      stdout: "pipe", stderr: "pipe",
    });
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    process.stdout.write(stdoutText);
    process.stderr.write(stderrText);
    const rc = await proc.exited;
    return { rc, output: stdoutText + stderrText };
  } catch {
    return { rc: 1, output: "" };
  }
}

/** Read the Claude CLI version baked into `image` by running `claude
 *  --version` inside a throwaway container, on the daemon named by
 *  `dockerArgs` (e.g. `["--context", "colima-cb-infra"]`, or `[]` for the
 *  ambient one — the caller computes this to match whatever `make` just
 *  built into). Returns undefined on any failure (image missing, daemon
 *  unreachable, unparseable output) — never throws, since this always runs
 *  after a build whose own failure is reported separately. */
async function defaultReadBakedClaudeVersion(image: string, dockerArgs: readonly string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["docker", ...dockerArgs, "run", "--rm", "--entrypoint", "claude", image, "--version"], {
      stdout: "pipe", stderr: "pipe",
    });
    const stdoutText = await new Response(proc.stdout).text();
    const rc = await proc.exited;
    if (rc !== 0) return undefined;
    // "2.1.319 (Claude Code)" -> "2.1.319"
    const match = /^(\d+\.\d+\.\d+)/.exec(stdoutText.trim());
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Resolve a named release channel to a concrete version via
 *  `${releasesUrl}/${channel}`. Mirrors install.sh's curl-based resolution.
 *  Returns the raw trimmed body (caller validates shape) or undefined on
 *  any network/HTTP failure. */
async function defaultResolveChannel(channel: string, releasesUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${releasesUrl}/${channel}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return undefined;
    const body = await res.text();
    return body.split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

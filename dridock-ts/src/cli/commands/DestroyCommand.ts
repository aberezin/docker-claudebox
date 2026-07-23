import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import type { Colima } from "../../infra/Colima.ts";
import { RealColima, resolveLimaHome } from "../../infra/Colima.ts";
import { projectProfile } from "../../infra/Docker.ts";
import type { Limactl } from "../../infra/Limactl.ts";
import { RealLimactl } from "../../infra/Limactl.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import { ProjectConfig } from "../../services/ProjectConfig.ts";
import { MachineConfig } from "../../services/MachineConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock destroy [--purge]` — destroy this project's VM. Ports
 * wrapper.sh:2402 → cb_vm_destroy + cb_purge_data.
 *
 * VM destroy also REAPS the leaked lima datadisk (bash's cb_vm_destroy at
 * :802 comment: "colima delete LEAKS the per-profile lima datadisk (a
 * whole sparse disk per destroyed project VM — they pile up as GBs of
 * dead weight)"). This runs even when the VM was already absent so it
 * also reclaims previously-leaked disks.
 *
 * `--purge` also removes the per-project data dir. Guards:
 *   - Refuses when DRIDOCK_DATA_DIR / CLAUDE_DATA_DIR override is set
 *     (that path is arbitrary/user-owned; only the user removes it).
 *   - Refuses if the id doesn't look like a real project id
 *     (hex-only; matches bash's `case "$id" in *[!0-9a-f]*)` guard).
 *
 * Arfy #38 P4c B4 caught (a) the previous version leaked the lima
 * datadisk (~7-14GB per destroy) and (b) rm-rf'd only `<data-dir>/<id>/
 * claude` not the full `<data-dir>/<id>` parent.
 */
export class DestroyCommand implements Command {
  readonly verb = "destroy" as const;

  constructor(
    private readonly colimaOverride?: Colima,
    private readonly gitOverride?: GitToplevel,
    private readonly limactlOverride?: Limactl,
  ) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    let purge = false;
    for (const arg of args) {
      switch (arg) {
        case "--purge": case "--purge-data": purge = true; break;
        case "-h": case "--help":
          ctx.stdout.write(`usage: ${ctx.binName} destroy [--purge]   (--purge also deletes this project's session/data dir)\n`);
          return 0;
        default:
          throw new DridockError(`destroy: unknown arg '${arg}' (try --help)`);
      }
    }

    const git = this.gitOverride ?? new RealGitToplevel();
    const project = await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
    const id = await new ProjectConfig(ctx.fs).projectId(project.configPath);
    if (id === undefined) {
      ctx.stdout.write(`no dridock project here (.dridock/config.yml missing)\n`);
      return 0;
    }
    const colima = this.colimaOverride ?? new RealColima();
    const limactl = this.limactlOverride ?? new RealLimactl();
    const profile = projectProfile(id);
    const vm = await colima.get(profile);
    if (vm === undefined) {
      ctx.stdout.write(`no VM for this project (${profile})\n`);
    } else {
      ctx.stdout.write(`  💥 destroying VM ${profile}...\n`);
      await colima.delete(profile);
      ctx.stdout.write(`  ✓ ${profile} destroyed\n`);
    }

    // Always reap the leaked lima datadisk (matches bash cb_vm_destroy
    // at :806-810 — runs regardless of prior VM state so previously-
    // leaked disks are also reclaimed). limactl refuses in-use disks
    // so this can't touch a live VM's disk.
    const limaHome = await resolveLimaHome(ctx.fs, process.env, ctx.home);
    if (limaHome !== undefined) {
      const rc = await limactl.diskDelete(limaHome, [`colima-${profile}`]);
      if (rc === 0) ctx.stdout.write(`   ✓ freed leaked lima datadisk (colima-${profile})\n`);
      // Silent on failure — matches bash's `>/dev/null 2>&1` shape (disk
      // may not exist if never leaked, or limactl may refuse; either is fine).
    }

    if (purge) return await this.purge(id, ctx);
    return 0;
  }

  private async purge(id: string, ctx: Context): Promise<number> {
    // Guard 1: id must be a real project id (hex-only, matches bash
    // wrapper.sh:821 `case "$id" in ''|*[!0-9a-f]*|*/*)`).
    if (!/^[0-9a-f]+$/.test(id)) {
      ctx.stderr.write(`refusing to purge — unexpected project id: '${id}'\n`);
      return 1;
    }
    // Guard 2: refuse when DRIDOCK_DATA_DIR override is set (matches
    // wrapper.sh:822 — that path is arbitrary/user-owned).
    const dataDirOverride = process.env["DRIDOCK_DATA_DIR"] ?? process.env["CLAUDE_DATA_DIR"];
    if (dataDirOverride !== undefined && dataDirOverride !== "") {
      ctx.stderr.write(`⚠ DRIDOCK_DATA_DIR override is set — not auto-deleting it; remove it yourself: ${dataDirOverride}\n`);
      return 0;
    }
    // Compute the per-project data dir (NOT its /claude subdir — bash's
    // cb_purge_data at :826 rms `<data_root>/<id>`, i.e. the parent
    // containing `claude/` AND anything else the entrypoint dropped
    // there). Arfy #38 P4c B4 caught the previous version only rm'd
    // `<id>/claude`, leaving an empty `<id>/` parent.
    const machine = new MachineConfig(ctx.fs, process.env, ctx.home);
    const claudeDir = await machine.projectDataDir(id);
    // projectDataDir returns `.../<id>/claude` — strip the trailing
    // `/claude` to get the parent.
    const projectRoot = claudeDir.endsWith("/claude") ? claudeDir.slice(0, -"/claude".length) : claudeDir;
    // Guard 3: refuse to purge unexpected paths. Matches wrapper.sh:827.
    if (!projectRoot.endsWith(`/${id}`)) {
      ctx.stderr.write(`refusing to purge unexpected path: ${projectRoot}\n`);
      return 1;
    }
    if (!(await ctx.fs.exists(projectRoot))) {
      ctx.stdout.write(`no per-project data dir to purge (${projectRoot})\n`);
      return 0;
    }
    ctx.stdout.write(`  🧹 purging data dir ${projectRoot}...\n`);
    await ctx.fs.removeDirRecursive(projectRoot);
    ctx.stdout.write(`  ✓ purged this project's session/data dir — history & sidecars gone\n`);
    return 0;
  }
}

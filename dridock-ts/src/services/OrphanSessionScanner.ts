import type { FileSystem } from "../infra/FileSystem.ts";
import { xdgRoot } from "../domain/paths.ts";

/**
 * Detect orphaned per-project session state for a workspace.
 *
 * Every dridock project's `~/.claude` mount, VMs, secrets, and sessions
 * are keyed on the project's `id:`. If a workspace's config.yml id gets
 * regenerated (see #42), any prior sessions live on under the OLD id at
 * `<xdg>/projects/<old-id>/claude/projects/<cwd-slug>/` — still on disk,
 * but no longer mounted by anyone launching this workspace.
 *
 * This scanner walks `<xdg>/projects/*` looking for session dirs whose
 * slug matches the given workspace cwd. Every match under a `<other-id>`
 * different from `ownId` is a potential orphan.
 *
 * Called from THREE sites (per Alan's tightening on #42 review):
 *   1. `BootstrapService` — pre-mint (before a fresh id gets committed)
 *   2. `StartCommand` — pre-launch (every `dridock-ts start` sanity-checks
 *      the id it's about to run against)
 *   3. `CronModeCommand` — pre-spawn (same shape as start, cron path)
 *
 * Empty dirs are ignored: a lingering post-clobber dir with no session
 * files is not a warning-worthy signal. Nag only when real state exists.
 */

export interface OrphanScanDeps {
  readonly fs: FileSystem;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
}

export interface OrphanCandidate {
  /** The `id:` of the other project owning the orphaned dir. */
  readonly id: string;
  /** Absolute path of the sibling session dir. */
  readonly path: string;
  /** How many entries (session files or subdirs) exist there. Zero = skipped. */
  readonly entryCount: number;
}

/**
 * Enumerate session dirs for `workspaceRoot` that live under a project id
 * OTHER than `ownId`. `ownId` is optional — pass `undefined` in the
 * pre-mint call (there is no own id yet). Empty dirs are excluded.
 */
export async function scanOrphans(
  deps: OrphanScanDeps,
  workspaceRoot: string,
  ownId: string | undefined,
): Promise<OrphanCandidate[]> {
  const xdg = await xdgRoot(deps.fs, deps.env, deps.home);
  const projectsRoot = `${xdg}/projects`;
  if (!(await deps.fs.isDirectory(projectsRoot))) return [];
  const slug = workspaceRoot.replaceAll("/", "-");
  const orphans: OrphanCandidate[] = [];
  let ids: readonly string[];
  try {
    ids = await deps.fs.listDir(projectsRoot);
  } catch {
    return []; // best-effort — projectsRoot raced or perms
  }
  for (const id of ids) {
    if (id === ownId) continue;
    const sessionDir = `${projectsRoot}/${id}/claude/projects/${slug}`;
    if (!(await deps.fs.isDirectory(sessionDir))) continue;
    let entries: readonly string[] = [];
    try { entries = await deps.fs.listDir(sessionDir); } catch { /* best-effort */ }
    if (entries.length === 0) continue; // clobbered-but-never-used sibling — no signal
    orphans.push({ id, path: sessionDir, entryCount: entries.length });
  }
  return orphans;
}

/**
 * Format the orphan warning for a MINT invocation (bootstrap, no ownId).
 * Emphasizes "you're about to orphan" and offers the adopt path.
 */
export function formatMintWarning(orphans: readonly OrphanCandidate[]): string[] {
  const lines: string[] = [];
  lines.push(`⚠️  bootstrap: minting a NEW project id will silently orphan existing session state under another id:`);
  for (const o of orphans) lines.push(`     ${o.path}   (${o.entryCount} entries)`);
  lines.push(`   To adopt an existing id instead of orphaning: abort now, then set`);
  lines.push(`     id: <one-of-the-above>`);
  lines.push(`   in .dridock/config.yml (creating that file if needed) and re-run bootstrap.`);
  lines.push(`   Continuing with a fresh id anyway — the orphaned state stays on disk (recoverable).`);
  return lines.map((l) => `${l}\n`);
}

/**
 * Format the orphan warning for a LAUNCH invocation (start / cron mode).
 * Emphasizes "your current id may be wrong" and offers the adopt path.
 * ownId is included in the text so users see immediately which id they're
 * launching under vs the ones that hold the orphaned state.
 */
export function formatLaunchWarning(ownId: string, orphans: readonly OrphanCandidate[]): string[] {
  const lines: string[] = [];
  lines.push(`⚠️  this workspace has session state under OTHER project id(s) — you're launching id ${ownId}:`);
  for (const o of orphans) lines.push(`     ${o.path}   (${o.entryCount} entries)`);
  lines.push(`   If the current id is wrong (e.g. a prior bootstrap regenerated it — see #42),`);
  lines.push(`   the sessions above will not be resumed. To adopt one of them: edit .dridock/config.yml,`);
  lines.push(`   set 'id: <one-of-the-above>', and re-run. Continuing with id ${ownId} anyway.`);
  return lines.map((l) => `${l}\n`);
}

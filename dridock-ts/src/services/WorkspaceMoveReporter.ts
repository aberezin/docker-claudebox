import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Report, don't migrate, the one thing a project move still costs (#123,
 * docs/design/path-independence.md § The mount is the exception).
 *
 * The workspace is mounted at its own host path (docker-out-of-docker needs
 * that), and Claude Code keys its session dir by its cwd. So after the project
 * directory moves, `--continue` finds nothing: the history sits under the old
 * path's slug. The session dir is the user's, written by a process we don't
 * control, so we don't move it. We say exactly what happened and give the `mv`.
 *
 * The last mounted path is recorded in the id-keyed state dir. On a start
 * whose root differs, and whose old slug holds history the new one lacks, this
 * returns `moved` (the caller exits 1: an rc to act on, per never-silently-
 * discard). The new path is recorded first, so starting again proceeds with a
 * fresh history if that's what the user wants. No override flag needed.
 */
export type MoveCheck = { readonly kind: "ok" } | { readonly kind: "moved"; readonly message: string };

/** Claude Code's project-dir slug: every non-alphanumeric character becomes `-`. */
export function sessionSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

export async function checkWorkspaceMove(
  fs: FileSystem,
  opts: { readonly stateRoot: string; readonly dataDir: string; readonly root: string; readonly binName: string },
): Promise<MoveCheck> {
  const record = `${opts.stateRoot}/last-workspace`;
  const prev = (await fs.readTextOrUndefined(record))?.trim();
  if (prev !== opts.root) {
    await fs.mkdirRecursive(opts.stateRoot);
    await fs.writeText(record, `${opts.root}\n`);
  }
  if (prev === undefined || prev === "" || prev === opts.root) return { kind: "ok" };

  const oldDir = `${opts.dataDir}/projects/${sessionSlug(prev)}`;
  const newDir = `${opts.dataDir}/projects/${sessionSlug(opts.root)}`;
  if (!(await fs.isDirectory(oldDir)) || (await fs.isDirectory(newDir))) return { kind: "ok" };
  let entries = 0;
  try { entries = (await fs.listDir(oldDir)).length; } catch { entries = 0; }
  if (entries === 0) return { kind: "ok" };

  return {
    kind: "moved",
    message: `❌ this project moved: ${prev} → ${opts.root}\n`
      + `   Claude keeps session history by directory, so the claudebot would start with none.\n`
      + `   The old history (${entries} entr${entries === 1 ? "y" : "ies"}) is still here:\n`
      + `     ${oldDir}\n`
      + `   To keep it, move it to the new path's slug, then start again:\n`
      + `     mv '${oldDir}' '${newDir}'\n`
      + `   To start fresh instead, just run '${opts.binName} start' again (this is only said once).\n`,
  };
}

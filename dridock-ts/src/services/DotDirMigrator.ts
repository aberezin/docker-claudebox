import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Move a project's `~/.claude` data under the new `$HOME` mount source (#80
 * phase 2).
 *
 *   <data-root>/<id>/claude/  ->  <data-root>/<id>/dot/.claude/
 *
 * `.claude` stops being its own bind mount and becomes a directory inside the
 * `dot/` mount, so its host path has to move even though its container path
 * (`~/.claude`) does not.
 *
 * This moves REAL user state — sessions, history.jsonl, plugins, cron state,
 * the injected CLAUDE.md, and the OAuth credentials; 27 MB on a live project.
 * Losing it loses the agent's memory and its login, so every branch here is
 * either a completed move or an untouched source. There is no partial state
 * that reports success.
 */
export type DotMigrateOutcome =
  | { readonly kind: "not-needed"; readonly reason: string }
  | { readonly kind: "migrated"; readonly from: string; readonly to: string }
  | { readonly kind: "failed"; readonly reason: string };

export class DotDirMigrator {
  constructor(private readonly fs: FileSystem) {}

  /**
   * @param projectRoot `<data-root>/<id>` — the parent holding both layouts.
   */
  async migrate(projectRoot: string): Promise<DotMigrateOutcome> {
    const legacy = `${projectRoot}/claude`;
    const dot = `${projectRoot}/dot`;
    const target = `${dot}/.claude`;

    const legacyExists = await this.fs.exists(legacy);
    const targetExists = await this.fs.exists(target);

    // Already migrated, or a fresh project with neither. Both are the steady
    // state and must stay silent — this runs on every launch.
    if (!legacyExists) {
      return { kind: "not-needed", reason: targetExists ? "already migrated" : "fresh project" };
    }

    // BOTH present. Do not merge and do not guess which is live: that would
    // risk overwriting a current session with a stale one. Refuse and say so.
    // (The repo rule: never silently discard user state.)
    if (targetExists) {
      return {
        kind: "failed",
        reason:
          `both ${legacy} and ${target} exist — refusing to merge. ` +
          `Keep whichever holds your current session and remove the other, then re-run.`,
      };
    }

    if (!(await this.fs.isDirectory(legacy))) {
      return { kind: "failed", reason: `${legacy} exists but is not a directory` };
    }

    try {
      await this.fs.mkdirRecursive(dot);
      await this.fs.move(legacy, target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "failed", reason: `moving ${legacy} -> ${target}: ${message}` };
    }

    // Verify rather than trust the move. A silent no-op here would leave the
    // caller mounting an empty dot dir over a container whose real state it
    // just orphaned.
    if (!(await this.fs.exists(target))) {
      return { kind: "failed", reason: `move reported success but ${target} does not exist` };
    }
    return { kind: "migrated", from: legacy, to: target };
  }
}

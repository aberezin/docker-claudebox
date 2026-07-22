import type { FileSystem } from "../../infra/FileSystem.ts";
import type { MigrationReport, Migrator } from "../MigrationReport.ts";

/**
 * Move a project's `.claudebox/` → `.dridock/`. Ports cb_migrate_workspace
 * at wrapper.sh:1930. Per-file (not blanket rename) so that a mid-migration
 * project with both dirs present ends up merged, not clobbered.
 *
 * Handles: config.yml, config.sample.yml, secrets.env (chmod 600 after
 * move), BRIEF.md. Rewrites `.gitignore` `/\.claudebox/` prefixes to
 * `/\.dridock/`. Removes the empty `.claudebox/` dir when everything
 * migrated cleanly.
 *
 * Split-brain (same file in both dirs) → "leaving both" skipped-conflict
 * report per file; the migrate verb accumulates the rc.
 */
const KNOWN_FILES = ["config.yml", "config.sample.yml", "secrets.env", "BRIEF.md"] as const;

export class WorkspaceMigrator implements Migrator {
  constructor(private readonly fs: FileSystem, private readonly root: string) {}

  async migrate(): Promise<readonly MigrationReport[]> {
    const src = `${this.root}/.claudebox`;
    const dst = `${this.root}/.dridock`;
    if (!(await this.fs.isDirectory(src))) return [{ item: "workspace", outcome: { kind: "nothing-to-do" } }];

    const reports: MigrationReport[] = [];
    await this.fs.mkdirRecursive(dst);

    let anySkipped = false;
    let anyMoved = false;
    const moved: string[] = [];
    const conflicts: string[] = [];

    for (const name of KNOWN_FILES) {
      const srcPath = `${src}/${name}`;
      const dstPath = `${dst}/${name}`;
      if (!(await this.fs.exists(srcPath))) continue;
      if (await this.fs.exists(dstPath)) {
        anySkipped = true;
        conflicts.push(name);
        continue;
      }
      await this.fs.move(srcPath, dstPath);
      if (name === "secrets.env") await this.fs.chmod(dstPath, 0o600);
      moved.push(name);
      anyMoved = true;
    }

    // Rewrite .gitignore's /.claudebox/ prefix lines to /.dridock/ (safe
    // atomic write — never a half-written .gitignore). Bash uses
    // `sed 's#^/\.claudebox/#/.dridock/#'`; we do the same substitution
    // per-line.
    const gitignorePath = `${this.root}/.gitignore`;
    const gitignoreText = await this.fs.readTextOrUndefined(gitignorePath);
    if (gitignoreText !== undefined) {
      const rewritten = gitignoreText
        .split("\n")
        .map((l) => l.replace(/^\/\.claudebox\//, "/.dridock/"))
        .join("\n");
      if (rewritten !== gitignoreText) await this.fs.writeTextAtomic(gitignorePath, rewritten);
    }

    // Try to remove the empty legacy dir. rmDirIfEmpty is idempotent — if
    // a conflict file left behind, this is a no-op (matches bash's
    // `rmdir 2>/dev/null || true`).
    if (anyMoved && !anySkipped) await this.fs.rmDirIfEmpty(src);

    if (anyMoved) {
      reports.push({
        item: "workspace",
        outcome: { kind: "applied", from: src, to: dst, note: `moved ${moved.length} file(s): ${moved.join(", ")}` },
      });
    }
    if (anySkipped) {
      reports.push({
        item: "workspace",
        outcome: {
          kind: "skipped-conflict",
          reason: `${conflicts.length} file(s) exist in BOTH .claudebox/ and .dridock/: ${conflicts.join(", ")}`,
          hints: [
            "Both copies were preserved — pick the one you want and delete the other.",
            `Then re-run 'dridock migrate' to remove the empty ${src}/.`,
          ],
        },
      });
    }
    if (!anyMoved && !anySkipped) {
      reports.push({ item: "workspace", outcome: { kind: "nothing-to-do" } });
    }
    return reports;
  }
}

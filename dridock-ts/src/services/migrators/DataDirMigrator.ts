import type { FileSystem } from "../../infra/FileSystem.ts";
import type { MigrationReport, Migrator } from "../MigrationReport.ts";

/**
 * Move `<xdg>/claudebox/projects/<id>/` → `<xdg>/dridock/projects/<id>/`.
 * Ports cb_migrate_data_dir at wrapper.sh:1961. Idempotent (no-op when
 * legacy dir absent). If both exist → skipped-conflict (needs human).
 */
export class DataDirMigrator implements Migrator {
  constructor(
    private readonly fs: FileSystem,
    private readonly xdgBase: string,   // e.g. `~/.config`
    private readonly projectId: string,
  ) {}

  async migrate(): Promise<readonly MigrationReport[]> {
    const item = `data-dir(${this.projectId})`;
    const oldRoot = `${this.xdgBase}/claudebox/projects`;
    const newRoot = `${this.xdgBase}/dridock/projects`;
    const oldPath = `${oldRoot}/${this.projectId}`;
    const newPath = `${newRoot}/${this.projectId}`;

    if (!(await this.fs.isDirectory(oldPath))) return [{ item, outcome: { kind: "nothing-to-do" } }];
    if (await this.fs.exists(newPath)) {
      return [{
        item,
        outcome: {
          kind: "skipped-conflict",
          reason: `data dir ${this.projectId}: both claudebox/ and dridock/ have it — leaving both`,
          hints: [
            `Pick which to keep (${oldPath} vs ${newPath}), delete the other, then re-run 'dridock migrate'.`,
          ],
        },
      }];
    }
    await this.fs.mkdirRecursive(newRoot);
    await this.fs.move(oldPath, newPath);
    return [{ item, outcome: { kind: "applied", from: oldPath, to: newPath } }];
  }
}

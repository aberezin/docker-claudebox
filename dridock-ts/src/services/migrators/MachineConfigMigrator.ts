import type { FileSystem } from "../../infra/FileSystem.ts";
import type { MigrationReport, Migrator } from "../MigrationReport.ts";

/**
 * Move `<xdg>/claudebox/config.yml` → `<xdg>/dridock/config.yml`. Ports
 * cb_migrate_machine_config at wrapper.sh:1979. Idempotent (no-op when
 * legacy file absent). Both-exist → skipped-conflict.
 */
export class MachineConfigMigrator implements Migrator {
  constructor(private readonly fs: FileSystem, private readonly xdgBase: string) {}

  async migrate(): Promise<readonly MigrationReport[]> {
    const item = "machine-config";
    const oldPath = `${this.xdgBase}/claudebox/config.yml`;
    const newPath = `${this.xdgBase}/dridock/config.yml`;

    if (!(await this.fs.exists(oldPath))) return [{ item, outcome: { kind: "nothing-to-do" } }];
    if (await this.fs.exists(newPath)) {
      return [{
        item,
        outcome: {
          kind: "skipped-conflict",
          reason: "machine config: both claudebox/config.yml and dridock/config.yml exist — leaving both",
          hints: [
            `Pick which to keep (${oldPath} vs ${newPath}), delete the other, then re-run 'dridock migrate'.`,
          ],
        },
      }];
    }
    await this.fs.mkdirRecursive(`${this.xdgBase}/dridock`);
    await this.fs.move(oldPath, newPath);
    return [{ item, outcome: { kind: "applied", from: oldPath, to: newPath } }];
  }
}

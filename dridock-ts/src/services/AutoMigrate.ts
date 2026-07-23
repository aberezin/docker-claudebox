import type { FileSystem } from "../infra/FileSystem.ts";
import type { ProcessProbe } from "../infra/ProcessProbe.ts";
import type { Clock } from "../infra/Clock.ts";
import { WorkspaceMigrator } from "./migrators/WorkspaceMigrator.ts";
import { DataDirMigrator } from "./migrators/DataDirMigrator.ts";
import { MachineConfigMigrator } from "./migrators/MachineConfigMigrator.ts";
import { StateDirsMigrator } from "./migrators/StateDirsMigrator.ts";
import { ProjectConfig } from "./ProjectConfig.ts";
import { configHome } from "../domain/paths.ts";
import type { MigrationReport } from "./MigrationReport.ts";

/**
 * Silently migrate a legacy `.claudebox/`-only workspace on the first
 * dridock invocation. Ports cb_auto_migrate at wrapper.sh:2105.
 *
 * No-op cases (all silent, no rc effect):
 *   - opt-out env: DRIDOCK_NO_AUTO_MIGRATE=1
 *   - no `.claudebox/` dir at project root
 *   - `.dridock/` already exists at project root (migration done or in
 *     progress — WorkspaceMigrator's split-brain path handles it)
 *
 * When it runs, prints a one-liner to stderr so the user isn't
 * surprised. Any migrator conflict does NOT block the caller — bash's
 * auto-migrate is "opportunistic," not gated. The explicit `dridock
 * migrate` verb is the one that surfaces rc + warnings.
 */
export interface AutoMigrateDeps {
  readonly fs: FileSystem;
  readonly probe: ProcessProbe;
  readonly clock: Clock;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly onNotice: (message: string) => void;
}

export async function autoMigrateIfNeeded(root: string, deps: AutoMigrateDeps): Promise<readonly MigrationReport[]> {
  if (truthy(deps.env["DRIDOCK_NO_AUTO_MIGRATE"] ?? deps.env["CLAUDEBOX_NO_AUTO_MIGRATE"] ?? deps.env["CLAUDE_NO_AUTO_MIGRATE"])) {
    return [];
  }
  const hasLegacy = await deps.fs.isDirectory(`${root}/.claudebox`);
  if (!hasLegacy) return [];
  const hasNew = await deps.fs.isDirectory(`${root}/.dridock`);
  if (hasNew) return [];

  deps.onNotice(`ℹ  auto-migrating legacy .claudebox → .dridock (silent; run '${"dridock"} migrate' for a supervised pass)\n`);

  const reports: MigrationReport[] = [];
  reports.push(...(await new WorkspaceMigrator(deps.fs, root).migrate()));

  const cfg = new ProjectConfig(deps.fs);
  const configPath = (await deps.fs.exists(`${root}/.dridock/config.yml`))
    ? `${root}/.dridock/config.yml`
    : `${root}/.claudebox/config.yml`;
  const projectId = await cfg.projectId(configPath);
  const xdgBase = configHome(deps.env, deps.home);
  if (projectId !== undefined) {
    reports.push(...(await new DataDirMigrator(deps.fs, xdgBase, projectId).migrate()));
  }
  reports.push(...(await new MachineConfigMigrator(deps.fs, xdgBase).migrate()));
  reports.push(...(await new StateDirsMigrator(deps.fs, deps.probe, deps.clock, xdgBase).migrate()));
  return reports;
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

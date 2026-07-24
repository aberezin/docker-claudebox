import type { FileSystem } from "../../infra/FileSystem.ts";
import type { ProcessProbe } from "../../infra/ProcessProbe.ts";
import type { Clock } from "../../infra/Clock.ts";
import type { MigrationReport, Migrator } from "../MigrationReport.ts";

/**
 * Move the four cross-project state subdirs (cdp / consult /
 * framework-bugs / host-agent) from `<xdg>/claudebox/<name>` to
 * `<xdg>/dridock/<name>`. Ports cb_migrate_state_dirs at wrapper.sh:2022.
 *
 * Two guards from #32 that this class encodes:
 *
 *   Defect A (live-Chrome): the cdp subdir hosts a running Chrome
 *   debug profile. Moving it renames inodes out from under Chrome,
 *   corrupting the SingletonLock. Guard: pgrep the cmdline for
 *   `--user-data-dir=<oldpath>`; if matched, skip THAT subdir with a
 *   loud warning ("bridge keeps working from the legacy path").
 *
 *   Defect B (split-brain): if both dirs exist, we don't strand the
 *   legacy content behind a "leaving both" scroll. Non-cdp names merge
 *   entry-by-entry (clean entries move over; collisions get a
 *   .legacy-<ts> suffix so both stay reachable). cdp is intentionally
 *   NOT merged — a Chrome profile is thousands of interdependent files
 *   and half a profile is worse than either.
 */
const STATE_NAMES = ["cdp", "consult", "framework-bugs", "host-agent"] as const;
type StateName = typeof STATE_NAMES[number];

export class StateDirsMigrator implements Migrator {
  constructor(
    private readonly fs: FileSystem,
    private readonly probe: ProcessProbe,
    private readonly clock: Clock,
    private readonly xdgBase: string,
  ) {}

  async migrate(): Promise<readonly MigrationReport[]> {
    const reports: MigrationReport[] = [];
    for (const name of STATE_NAMES) {
      const rep = await this.migrateOne(name);
      if (rep !== undefined) reports.push(rep);
    }
    // Remove the now-empty claudebox root if empty. Cheap, silent on failure.
    await this.fs.rmDirIfEmpty(`${this.xdgBase}/claudebox`);
    return reports;
  }

  private async migrateOne(name: StateName): Promise<MigrationReport | undefined> {
    const item = `state:${name}`;
    const oldPath = `${this.xdgBase}/claudebox/${name}`;
    const newPath = `${this.xdgBase}/dridock/${name}`;

    if (!(await this.fs.isDirectory(oldPath))) return { item, outcome: { kind: "nothing-to-do" } };

    // Defect A guard — cdp only.
    if (name === "cdp") {
      const chromeRunning = await this.probe.processMatchingCmdline(`--user-data-dir=${oldPath}`);
      if (chromeRunning) {
        return {
          item,
          outcome: {
            kind: "skipped-conflict",
            reason: `state dir cdp: Chrome is running against ${oldPath}`,
            hints: [
              "Close Chrome (or run 'dridock browser-bridge down'), then 'dridock migrate' again.",
              "The bridge keeps working from the legacy path until then.",
            ],
          },
        };
      }
    }

    if (await this.fs.exists(newPath)) {
      // Defect B — merge, don't orphan. cdp explicitly excluded.
      if (name === "cdp") {
        return {
          item,
          outcome: {
            kind: "skipped-conflict",
            reason: "state dir cdp: SPLIT — both roots exist. Cannot auto-merge a Chrome profile safely.",
            hints: [
              "'dridock browser-bridge down', close Chrome, then keep whichever profile you want and delete the other.",
            ],
          },
        };
      }

      const suffix = `.legacy-${this.clock.timestamp()}`;
      let cleanCount = 0;
      let collisionCount = 0;
      // Bash uses `shopt -s nullglob dotglob` so hidden files migrate too.
      // listDir returns everything (dotfiles included) — same shape.
      const entries = await this.fs.listDir(oldPath);
      for (const entry of entries) {
        const from = `${oldPath}/${entry}`;
        const cleanTo = `${newPath}/${entry}`;
        if (!(await this.fs.exists(cleanTo))) {
          await this.fs.move(from, cleanTo);
          cleanCount++;
        } else {
          await this.fs.move(from, `${newPath}/${entry}${suffix}`);
          collisionCount++;
        }
      }
      await this.fs.rmDirIfEmpty(oldPath);

      return {
        item,
        outcome: {
          kind: "merged",
          from: oldPath,
          to: newPath,
          cleanCount,
          ...(collisionCount > 0 ? { collisionCount, collidedSuffix: suffix } : {}),
        },
      };
    }

    // Clean move — no dest exists.
    await this.fs.mkdirRecursive(`${this.xdgBase}/dridock`);
    await this.fs.move(oldPath, newPath);
    return { item, outcome: { kind: "applied", from: oldPath, to: newPath } };
  }
}

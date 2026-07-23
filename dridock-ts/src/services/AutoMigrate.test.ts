import { test, expect, describe } from "bun:test";
import { autoMigrateIfNeeded } from "./AutoMigrate.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { StubProcessProbe } from "../infra/ProcessProbe.ts";
import { FrozenClock } from "../infra/Clock.ts";

function build(env: Record<string, string | undefined> = {}): { fs: InMemoryFileSystem; notices: string[]; deps: Parameters<typeof autoMigrateIfNeeded>[1] } {
  const fs = new InMemoryFileSystem();
  const notices: string[] = [];
  return {
    fs, notices,
    deps: {
      fs, probe: new StubProcessProbe(), clock: new FrozenClock(),
      env, home: "/home/alan",
      onNotice: (m) => notices.push(m),
    },
  };
}

describe("autoMigrateIfNeeded", () => {
  test("no .claudebox → silent no-op, empty reports", async () => {
    const { fs, notices, deps } = build();
    const reports = await autoMigrateIfNeeded("/repo", deps);
    expect(reports).toEqual([]);
    expect(notices).toEqual([]);
    expect(fs.recordedWrites).toEqual([]);
  });

  test(".dridock already exists → silent no-op (migration already done or in progress)", async () => {
    const { fs, notices, deps } = build();
    fs.seedDir("/repo/.claudebox");
    fs.seedDir("/repo/.dridock");
    const reports = await autoMigrateIfNeeded("/repo", deps);
    expect(reports).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("DRIDOCK_NO_AUTO_MIGRATE=1 opts out even when .claudebox exists alone", async () => {
    const { fs, notices, deps } = build({ DRIDOCK_NO_AUTO_MIGRATE: "1" });
    fs.seedDir("/repo/.claudebox");
    fs.seed("/repo/.claudebox/config.yml", "id: abc\n");
    const reports = await autoMigrateIfNeeded("/repo", deps);
    expect(reports).toEqual([]);
    expect(notices).toEqual([]);
    // Config still at legacy path — untouched
    expect(await fs.exists("/repo/.claudebox/config.yml")).toBe(true);
  });

  test("legacy CLAUDEBOX_NO_AUTO_MIGRATE also honored", async () => {
    const { fs, notices, deps } = build({ CLAUDEBOX_NO_AUTO_MIGRATE: "true" });
    fs.seedDir("/repo/.claudebox");
    fs.seed("/repo/.claudebox/config.yml", "id: abc\n");
    expect(await autoMigrateIfNeeded("/repo", deps)).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("legacy-only project → migrates config.yml + emits notice + returns applied reports", async () => {
    const { fs, notices, deps } = build();
    fs.seed("/repo/.claudebox/config.yml", "id: abc\n");
    fs.seed("/repo/.claudebox/secrets.env", "GH=1\n", { mode: 0o644 });
    const reports = await autoMigrateIfNeeded("/repo", deps);
    // Content actually moved
    expect(await fs.exists("/repo/.dridock/config.yml")).toBe(true);
    expect(await fs.readText("/repo/.dridock/config.yml")).toBe("id: abc\n");
    expect(fs.modeOf("/repo/.dridock/secrets.env")).toBe(0o600);   // chmodded by WorkspaceMigrator
    // Notice printed
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("auto-migrating");
    // At least one applied report
    expect(reports.some((r) => r.outcome.kind === "applied")).toBe(true);
  });

  test("legacy project + legacy data dir → data-dir migrator ALSO runs (reads id from post-workspace-migrate path)", async () => {
    const { fs, deps } = build();
    fs.seed("/repo/.claudebox/config.yml", "id: xyz\n");
    fs.seed("/home/alan/.config/claudebox/projects/xyz/state.json", "{}");
    await autoMigrateIfNeeded("/repo", deps);
    expect(await fs.readText("/home/alan/.config/dridock/projects/xyz/state.json")).toBe("{}");
  });
});

import { test, expect, describe } from "bun:test";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { StubProcessProbe } from "../../infra/ProcessProbe.ts";
import { FrozenClock } from "../../infra/Clock.ts";
import { WorkspaceMigrator } from "./WorkspaceMigrator.ts";
import { DataDirMigrator } from "./DataDirMigrator.ts";
import { MachineConfigMigrator } from "./MachineConfigMigrator.ts";
import { StateDirsMigrator } from "./StateDirsMigrator.ts";

describe("WorkspaceMigrator", () => {
  test("no .claudebox → nothing-to-do", async () => {
    const fs = new InMemoryFileSystem();
    const reports = await new WorkspaceMigrator(fs, "/p").migrate();
    expect(reports).toEqual([{ item: "workspace", outcome: { kind: "nothing-to-do" } }]);
  });

  test("moves known files + chmods secrets.env to 600 + removes empty legacy dir", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.claudebox/config.yml", "id: abc\n");
    fs.seed("/p/.claudebox/secrets.env", "GH_TOKEN=abc\n", { mode: 0o644 });
    const reports = await new WorkspaceMigrator(fs, "/p").migrate();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outcome.kind).toBe("applied");
    expect(await fs.readText("/p/.dridock/config.yml")).toBe("id: abc\n");
    expect(await fs.readText("/p/.dridock/secrets.env")).toBe("GH_TOKEN=abc\n");
    expect(fs.modeOf("/p/.dridock/secrets.env")).toBe(0o600);
    expect(await fs.exists("/p/.claudebox")).toBe(false);
  });

  test("split-brain (same file in both dirs) → skipped-conflict, both files intact", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.claudebox/config.yml", "old\n");
    fs.seed("/p/.dridock/config.yml", "new\n");
    const reports = await new WorkspaceMigrator(fs, "/p").migrate();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outcome).toMatchObject({
      kind: "skipped-conflict",
      reason: expect.stringContaining("config.yml"),
    });
    // Neither file touched
    expect(await fs.readText("/p/.claudebox/config.yml")).toBe("old\n");
    expect(await fs.readText("/p/.dridock/config.yml")).toBe("new\n");
  });

  test("partial: one clean, one conflicting → both reports emitted", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.claudebox/config.yml", "unique\n");
    fs.seed("/p/.claudebox/secrets.env", "GH=1\n");
    fs.seed("/p/.dridock/secrets.env", "GH=2\n");
    const reports = await new WorkspaceMigrator(fs, "/p").migrate();
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.outcome.kind).sort()).toEqual(["applied", "skipped-conflict"]);
    // Clean-moved file is at destination
    expect(await fs.readText("/p/.dridock/config.yml")).toBe("unique\n");
    // Conflicted file preserved on both sides
    expect(await fs.readText("/p/.claudebox/secrets.env")).toBe("GH=1\n");
  });

  test("rewrites .gitignore's /.claudebox/ prefix lines to /.dridock/", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.claudebox/config.yml", "x");
    fs.seed("/p/.gitignore", [
      "/.claudebox/config.yml",
      "/.claudebox/secrets.env",
      "node_modules/",
      "not-a-claudebox-line",
    ].join("\n"));
    await new WorkspaceMigrator(fs, "/p").migrate();
    const rewritten = await fs.readText("/p/.gitignore");
    expect(rewritten).toContain("/.dridock/config.yml");
    expect(rewritten).toContain("/.dridock/secrets.env");
    expect(rewritten).toContain("node_modules/");
    expect(rewritten).toContain("not-a-claudebox-line");
    expect(rewritten).not.toContain("/.claudebox/");
  });

  test("legacy dir with no known files inside → nothing-to-do", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/p/.claudebox");
    fs.seed("/p/.claudebox/unrelated", "x");   // migrator doesn't move unrelated files
    const reports = await new WorkspaceMigrator(fs, "/p").migrate();
    expect(reports).toEqual([{ item: "workspace", outcome: { kind: "nothing-to-do" } }]);
    expect(await fs.exists("/p/.claudebox/unrelated")).toBe(true);   // untouched
  });
});

describe("DataDirMigrator", () => {
  test("no legacy dir → nothing-to-do", async () => {
    const fs = new InMemoryFileSystem();
    const reports = await new DataDirMigrator(fs, "/home/alan/.config", "abc12345").migrate();
    expect(reports[0]!.outcome.kind).toBe("nothing-to-do");
  });

  test("clean move", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/projects/abc/state.json", "{}");
    const reports = await new DataDirMigrator(fs, "/home/alan/.config", "abc").migrate();
    expect(reports[0]!.outcome.kind).toBe("applied");
    expect(await fs.readText("/home/alan/.config/dridock/projects/abc/state.json")).toBe("{}");
  });

  test("both exist → skipped-conflict, neither touched", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/projects/abc/x", "old");
    fs.seed("/home/alan/.config/dridock/projects/abc/x", "new");
    const reports = await new DataDirMigrator(fs, "/home/alan/.config", "abc").migrate();
    expect(reports[0]!.outcome.kind).toBe("skipped-conflict");
    expect(await fs.readText("/home/alan/.config/claudebox/projects/abc/x")).toBe("old");
  });
});

describe("MachineConfigMigrator", () => {
  test("no legacy → nothing-to-do", async () => {
    const fs = new InMemoryFileSystem();
    const reports = await new MachineConfigMigrator(fs, "/home/alan/.config").migrate();
    expect(reports[0]!.outcome.kind).toBe("nothing-to-do");
  });

  test("clean move", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/config.yml", "data_root: ~/dridock\n");
    const reports = await new MachineConfigMigrator(fs, "/home/alan/.config").migrate();
    expect(reports[0]!.outcome.kind).toBe("applied");
    expect(await fs.readText("/home/alan/.config/dridock/config.yml")).toBe("data_root: ~/dridock\n");
  });

  test("both exist → skipped-conflict, neither touched", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/config.yml", "old");
    fs.seed("/home/alan/.config/dridock/config.yml", "new");
    const reports = await new MachineConfigMigrator(fs, "/home/alan/.config").migrate();
    expect(reports[0]!.outcome.kind).toBe("skipped-conflict");
    expect(await fs.readText("/home/alan/.config/claudebox/config.yml")).toBe("old");
    expect(await fs.readText("/home/alan/.config/dridock/config.yml")).toBe("new");
  });
});

describe("StateDirsMigrator — happy paths", () => {
  test("no legacy dirs → all nothing-to-do", async () => {
    const fs = new InMemoryFileSystem();
    const reports = await new StateDirsMigrator(fs, new StubProcessProbe(), new FrozenClock(), "/home/alan/.config").migrate();
    for (const r of reports) expect(r.outcome.kind).toBe("nothing-to-do");
  });

  test("clean move of consult (dst absent)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/consult/thread-1/meta", "status=resolved\n");
    const reports = await new StateDirsMigrator(fs, new StubProcessProbe(), new FrozenClock(), "/home/alan/.config").migrate();
    const consult = reports.find((r) => r.item === "state:consult")!;
    expect(consult.outcome.kind).toBe("applied");
    expect(await fs.readText("/home/alan/.config/dridock/consult/thread-1/meta")).toBe("status=resolved\n");
    expect(await fs.exists("/home/alan/.config/claudebox/consult")).toBe(false);
  });
});

describe("StateDirsMigrator — Defect A (live-Chrome guard)", () => {
  test("cdp SKIPPED when pgrep finds --user-data-dir=<old>", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/cdp/chrome-debug-profile/marker", "x");
    const probe = new StubProcessProbe();
    probe.seedMatch("--user-data-dir=/home/alan/.config/claudebox/cdp", true);
    const reports = await new StateDirsMigrator(fs, probe, new FrozenClock(), "/home/alan/.config").migrate();
    const cdp = reports.find((r) => r.item === "state:cdp")!;
    expect(cdp.outcome).toMatchObject({
      kind: "skipped-conflict",
      reason: expect.stringContaining("Chrome is running"),
    });
    // Legacy content preserved — bridge keeps working
    expect(await fs.exists("/home/alan/.config/claudebox/cdp/chrome-debug-profile/marker")).toBe(true);
  });

  test("cdp moves when Chrome is NOT running against it (probe returns false)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/cdp/marker", "x");
    const reports = await new StateDirsMigrator(fs, new StubProcessProbe(), new FrozenClock(), "/home/alan/.config").migrate();
    const cdp = reports.find((r) => r.item === "state:cdp")!;
    expect(cdp.outcome.kind).toBe("applied");
    expect(await fs.readText("/home/alan/.config/dridock/cdp/marker")).toBe("x");
  });
});

describe("StateDirsMigrator — Defect B (split-brain merge)", () => {
  test("both dirs exist for consult: clean entries move, collisions get .legacy-<ts> suffix", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/consult/only-old/meta", "old-only");
    fs.seed("/home/alan/.config/claudebox/consult/shared/meta", "old-shared");
    fs.seed("/home/alan/.config/dridock/consult/only-new/meta", "new-only");
    fs.seed("/home/alan/.config/dridock/consult/shared/meta", "new-shared");
    const clock = new FrozenClock("20260722010203");
    const reports = await new StateDirsMigrator(fs, new StubProcessProbe(), clock, "/home/alan/.config").migrate();
    const consult = reports.find((r) => r.item === "state:consult")!;
    expect(consult.outcome).toMatchObject({
      kind: "merged", cleanCount: 1, collisionCount: 1,
      collidedSuffix: ".legacy-20260722010203",
    });
    // Clean entry merged in; new-only kept; collision preserved BOTH ways
    expect(await fs.readText("/home/alan/.config/dridock/consult/only-old/meta")).toBe("old-only");
    expect(await fs.readText("/home/alan/.config/dridock/consult/only-new/meta")).toBe("new-only");
    expect(await fs.readText("/home/alan/.config/dridock/consult/shared/meta")).toBe("new-shared"); // dridock winner
    expect(await fs.readText("/home/alan/.config/dridock/consult/shared.legacy-20260722010203/meta")).toBe("old-shared");
    // Empty legacy consult dir removed
    expect(await fs.exists("/home/alan/.config/claudebox/consult")).toBe(false);
  });

  test("cdp gets a distinct SPLIT skipped-conflict (never auto-merged)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/claudebox/cdp/marker", "old");
    fs.seed("/home/alan/.config/dridock/cdp/marker", "new");
    const reports = await new StateDirsMigrator(fs, new StubProcessProbe(), new FrozenClock(), "/home/alan/.config").migrate();
    const cdp = reports.find((r) => r.item === "state:cdp")!;
    expect(cdp.outcome).toMatchObject({
      kind: "skipped-conflict",
      reason: expect.stringContaining("SPLIT"),
    });
    // Both preserved
    expect(await fs.readText("/home/alan/.config/claudebox/cdp/marker")).toBe("old");
    expect(await fs.readText("/home/alan/.config/dridock/cdp/marker")).toBe("new");
  });
});

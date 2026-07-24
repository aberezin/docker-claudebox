import { test, expect, describe, afterEach } from "bun:test";
import { scanOrphans, formatMintWarning, formatLaunchWarning } from "./OrphanSessionScanner.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

// XDG_CONFIG_HOME reads from process.env via xdgRoot — snapshot + restore.
const savedXdg = { v: process.env["XDG_CONFIG_HOME"] };
afterEach(() => {
  if (savedXdg.v === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = savedXdg.v;
});
function setXdg(v: string | undefined): void {
  if (v === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = v;
}

describe("scanOrphans — the core cwd→slug→foreign-id walk", () => {
  test("returns empty when projects root doesn't exist yet", async () => {
    setXdg("/home/alan/.config");
    const fs = new InMemoryFileSystem();
    const orphans = await scanOrphans(
      { fs, env: process.env, home: "/home/alan" },
      "/repo",
      undefined,
    );
    expect(orphans).toEqual([]);
  });

  test("returns empty when no sibling projects match this cwd slug", async () => {
    setXdg("/home/alan/.config");
    const fs = new InMemoryFileSystem();
    // A sibling for a DIFFERENT workspace exists — must not match /repo.
    fs.seed("/home/alan/.config/dridock/projects/aabbccdd/claude/projects/-other/x.jsonl", "{}");
    const orphans = await scanOrphans(
      { fs, env: process.env, home: "/home/alan" },
      "/repo",
      undefined,
    );
    expect(orphans).toEqual([]);
  });

  test("lists foreign ids whose session dir matches this cwd, sorted-stable by scanner order", async () => {
    setXdg("/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/projects/69adc719/claude/projects/-repo/session-1.jsonl", "{}");
    fs.seed("/home/alan/.config/dridock/projects/69adc719/claude/projects/-repo/session-2.jsonl", "{}");
    fs.seed("/home/alan/.config/dridock/projects/aabbccdd/claude/projects/-repo/session-x.jsonl", "{}");
    const orphans = await scanOrphans(
      { fs, env: process.env, home: "/home/alan" },
      "/repo",
      undefined,
    );
    expect(orphans.map((o) => o.id).sort()).toEqual(["69adc719", "aabbccdd"]);
    const first = orphans.find((o) => o.id === "69adc719")!;
    expect(first.path).toBe("/home/alan/.config/dridock/projects/69adc719/claude/projects/-repo");
    expect(first.entryCount).toBe(2);
  });

  test("EXCLUDES ownId — the current project's own dir is not an orphan of itself", async () => {
    setXdg("/home/alan/.config");
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/projects/mine1234/claude/projects/-repo/session.jsonl", "{}");
    fs.seed("/home/alan/.config/dridock/projects/deadbeef/claude/projects/-repo/session.jsonl", "{}");
    const orphans = await scanOrphans(
      { fs, env: process.env, home: "/home/alan" },
      "/repo",
      "mine1234",
    );
    // Only deadbeef surfaces; mine1234 is filtered as ownId.
    expect(orphans.map((o) => o.id)).toEqual(["deadbeef"]);
  });

  test("SKIPS empty dirs — a clobbered-but-never-used sibling produces no signal", async () => {
    setXdg("/home/alan/.config");
    const fs = new InMemoryFileSystem();
    // Real session — should surface.
    fs.seed("/home/alan/.config/dridock/projects/real0001/claude/projects/-repo/session.jsonl", "{}");
    // Empty dir — clobber remnant — must NOT surface.
    // (InMemoryFileSystem: seed a marker then delete/clear it — or mkdir directly.)
    await fs.mkdirRecursive("/home/alan/.config/dridock/projects/empty002/claude/projects/-repo");
    const orphans = await scanOrphans(
      { fs, env: process.env, home: "/home/alan" },
      "/repo",
      undefined,
    );
    expect(orphans.map((o) => o.id)).toEqual(["real0001"]);
  });

  test("respects XDG_CONFIG_HOME override", async () => {
    setXdg("/custom/xdg");
    const fs = new InMemoryFileSystem();
    fs.seed("/custom/xdg/dridock/projects/aa/claude/projects/-repo/s.jsonl", "{}");
    const orphans = await scanOrphans(
      { fs, env: process.env, home: "/ignored-when-xdg-set" },
      "/repo",
      undefined,
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.path).toBe("/custom/xdg/dridock/projects/aa/claude/projects/-repo");
  });
});

describe("formatMintWarning — the bootstrap-mint text", () => {
  test("lists each orphan with entry count, plus the adopt recovery hint", () => {
    const lines = formatMintWarning([
      { id: "aa", path: "/xdg/dridock/projects/aa/claude/projects/-repo", entryCount: 5 },
      { id: "bb", path: "/xdg/dridock/projects/bb/claude/projects/-repo", entryCount: 1 },
    ]);
    const text = lines.join("");
    expect(text).toContain(`⚠️  bootstrap: minting a NEW project id will silently orphan`);
    expect(text).toContain(`/xdg/dridock/projects/aa/claude/projects/-repo   (5 entries)`);
    expect(text).toContain(`/xdg/dridock/projects/bb/claude/projects/-repo   (1 entries)`);
    expect(text).toContain(`id: <one-of-the-above>`);
    expect(text).toContain(`Continuing with a fresh id anyway`);
  });
});

describe("formatLaunchWarning — the start/cron text", () => {
  test("shows the launching id vs the orphaned ids for immediate context", () => {
    const lines = formatLaunchWarning("current1", [
      { id: "orphaned1", path: "/xdg/dridock/projects/orphaned1/claude/projects/-repo", entryCount: 12 },
    ]);
    const text = lines.join("");
    // The critical bit: user sees at a glance which id they're about to
    // launch under, vs the id that actually owns their history.
    expect(text).toContain(`you're launching id current1`);
    expect(text).toContain(`/xdg/dridock/projects/orphaned1/claude/projects/-repo   (12 entries)`);
    expect(text).toContain(`see #42`);
    expect(text).toContain(`Continuing with id current1 anyway`);
  });
});

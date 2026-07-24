import { test, expect, describe, afterEach } from "bun:test";
import { findNoDridockMarker, formatNoDridockRefusal, shouldCheckNoDridock, NO_DRIDOCK_MARKER } from "./NoDridockGuard.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

describe("findNoDridockMarker — walks cwd → ancestors, stops at $HOME or /", () => {
  test("marker AT cwd → returns that path", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/proj/.nodridock", "");
    const p = await findNoDridockMarker(fs, "/home/alan/proj", "/home/alan");
    expect(p).toBe("/home/alan/proj/.nodridock");
  });

  test("marker at PARENT → returns parent's path (subtree protection)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/protected/.nodridock", "");
    const p = await findNoDridockMarker(fs, "/home/alan/protected/deep/sub", "/home/alan");
    expect(p).toBe("/home/alan/protected/.nodridock");
  });

  test("marker at $HOME → returned (blanket protection of user tree)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.nodridock", "");
    const p = await findNoDridockMarker(fs, "/home/alan/whatever/nested", "/home/alan");
    expect(p).toBe("/home/alan/.nodridock");
  });

  test("no marker anywhere along the chain → undefined", async () => {
    const fs = new InMemoryFileSystem();
    const p = await findNoDridockMarker(fs, "/home/alan/proj", "/home/alan");
    expect(p).toBeUndefined();
  });

  test("marker ABOVE $HOME is NOT considered (walk stops at $HOME inclusive)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/.nodridock", "");   // above $HOME
    const p = await findNoDridockMarker(fs, "/home/alan/proj", "/home/alan");
    expect(p).toBeUndefined();
  });

  test("marker at $HOME wins over one at PARENT (nearest wins — cwd upward)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.nodridock", "");
    fs.seed("/home/alan/proj/.nodridock", "");
    const p = await findNoDridockMarker(fs, "/home/alan/proj/deep", "/home/alan");
    // Walk from /home/alan/proj/deep upward: proj/.nodridock hits FIRST.
    expect(p).toBe("/home/alan/proj/.nodridock");
  });

  test("home = / (no user-tree bound) still terminates", async () => {
    const fs = new InMemoryFileSystem();
    const p = await findNoDridockMarker(fs, "/some/dir", "/");
    expect(p).toBeUndefined();
  });

  test("home with trailing slash normalized (regression-safe: '/home/alan/' == '/home/alan')", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.nodridock", "");
    const p = await findNoDridockMarker(fs, "/home/alan/proj", "/home/alan/");
    expect(p).toBe("/home/alan/.nodridock");
  });

  test("marker filename is exactly '.nodridock' (regression-safe: doesn't misfire on '.nodridock.bak')", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/proj/.nodridock.bak", "");
    fs.seed("/home/alan/proj/nodridock", "");
    const p = await findNoDridockMarker(fs, "/home/alan/proj", "/home/alan");
    expect(p).toBeUndefined();
    expect(NO_DRIDOCK_MARKER).toBe(".nodridock");
  });
});

describe("formatNoDridockRefusal — human-facing refusal text", () => {
  test("names the verb, the marker path, and the removal instruction", () => {
    const lines = formatNoDridockRefusal("/home/alan/proj/.nodridock", "start", "dridock");
    const text = lines.join("");
    expect(text).toContain(`❌ dridock start: dridock is disabled in this directory tree.`);
    expect(text).toContain(`Found: /home/alan/proj/.nodridock`);
    expect(text).toContain(`Remove that file`);
    expect(text).toContain(`'cd' out of this tree`);
    expect(text).toContain(`.nodridock`);
    expect(text).toContain(`subdirectory`);
  });

  test("binName in the message reflects what the user actually typed (`dridock-ts` vs `dridock`)", () => {
    const lines = formatNoDridockRefusal("/x/.nodridock", "bootstrap", "dridock-ts");
    expect(lines.join("")).toContain(`❌ dridock-ts bootstrap:`);
  });
});

/** Snapshot process.env["DRIDOCK_MODE_CRON"] so cron-mode tests don't leak. */
const savedCron = { v: process.env["DRIDOCK_MODE_CRON"] };
afterEach(() => {
  if (savedCron.v === undefined) delete process.env["DRIDOCK_MODE_CRON"];
  else process.env["DRIDOCK_MODE_CRON"] = savedCron.v;
});

describe("shouldCheckNoDridock — dispatch-level policy", () => {
  const noCronEnv = {} as Record<string, string | undefined>;

  test("cron mode requested → always YES, even with no args", () => {
    expect(shouldCheckNoDridock([], { DRIDOCK_MODE_CRON: "1" })).toBe(true);
    // With a verb arg that would otherwise skip (e.g. `help`), cron still wins.
    expect(shouldCheckNoDridock(["help"], { DRIDOCK_MODE_CRON: "1" })).toBe(true);
  });

  test("bareword (no args) → YES (fall-through start-hint path)", () => {
    expect(shouldCheckNoDridock([], noCronEnv)).toBe(true);
  });

  test("first arg starts with `-` (e.g. `-p '…'`) → YES (programmatic start-adjacent)", () => {
    expect(shouldCheckNoDridock(["-p", "prompt"], noCronEnv)).toBe(true);
    expect(shouldCheckNoDridock(["--print", "prompt"], noCronEnv)).toBe(true);
  });

  test("creates-or-launches verbs → YES (start + bootstrap only, per the narrow whitelist)", () => {
    expect(shouldCheckNoDridock(["start"], noCronEnv)).toBe(true);
    expect(shouldCheckNoDridock(["bootstrap"], noCronEnv)).toBe(true);
    expect(shouldCheckNoDridock(["start", "--rc"], noCronEnv)).toBe(true);
    expect(shouldCheckNoDridock(["bootstrap", "--force"], noCronEnv)).toBe(true);
  });

  test("cleanup + inspection verbs → NO (user must always be able to stop/destroy/info an existing project in a protected tree)", () => {
    // Cleanup: essential — user just enabled .nodridock but wants to shut
    // down what they'd previously started here.
    expect(shouldCheckNoDridock(["stop"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["down"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["destroy"], noCronEnv)).toBe(false);
    // Inspection: read-only, doesn't launch anything.
    expect(shouldCheckNoDridock(["info"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["status"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["checkversion"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["ip"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["net"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["df"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["claude-dir"], noCronEnv)).toBe(false);
    // Config edits: change state but don't launch a container.
    expect(shouldCheckNoDridock(["features"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["migrate"], noCronEnv)).toBe(false);
    // Meta / non-cwd verbs.
    expect(shouldCheckNoDridock(["help"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["version"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["completion"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["framework-bugs"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["consult"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["report-bug"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["harness"], noCronEnv)).toBe(false);
    // Throwaway passthroughs: don't create state in cwd.
    expect(shouldCheckNoDridock(["setup-token"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["doctor"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["auth"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["mcp"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["clear-session"], noCronEnv)).toBe(false);
  });

  test("unknown verb → NO (defer to registry's own error, don't shadow it with the guard)", () => {
    expect(shouldCheckNoDridock(["nonsense-verb"], noCronEnv)).toBe(false);
    expect(shouldCheckNoDridock(["definitely not a verb"], noCronEnv)).toBe(false);
  });

  test("legacy CLAUDE_MODE_CRON=1 also triggers cron-mode guard (bash-parity)", () => {
    expect(shouldCheckNoDridock(["help"], { CLAUDE_MODE_CRON: "1" })).toBe(true);
  });
});

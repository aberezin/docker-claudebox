import { test, expect, describe } from "bun:test";
import { HelpCommand } from "./commands/HelpCommand.ts";
import { buildRegistry } from "./buildRegistry.ts";
import { VERBS } from "../domain/Verbs.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { StringWriter } from "./Context.ts";
import type { Context } from "./Context.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";

/**
 * `dridock --help` must mention every verb you can actually run.
 *
 * Why this test exists: `HelpCommand.renderSection` is driven by hardcoded
 * arrays of verb names — a SECOND source of truth next to `VERBS` and the
 * registry, and nothing about adding a verb forces the three to agree.
 *
 * #97 added `plugins`: declared in VERBS, registered, dispatching, with 20
 * passing tests of its own — and completely absent from `dridock --help`. The
 * whole suite stayed green, because every existing test asked "does this verb
 * work" and none asked "can a user find it". That is the same shape as the
 * `--help` defects #60 and #93 were filed for, so it gets a test rather than a
 * fix.
 *
 * Deliberately asserted against the REGISTRY, not against VERBS alone: the
 * registry is what the dispatcher will actually accept, so it is the honest
 * definition of "a verb a user can run".
 */

function renderHelp(): string {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  const ctx: Context = {
    fs: new InMemoryFileSystem(),
    env: new EnvResolver({}),
    cwd: "/p",
    home: "/home/alan",
    binName: "dridock",
    stdout,
    stderr,
  };
  // HelpCommand.run is async but writes synchronously before any await.
  void new HelpCommand().run([], ctx);
  return stdout.text();
}

describe("dridock --help covers every runnable verb", () => {
  test("every registered verb appears in the help output", () => {
    const help = renderHelp();
    const missing = buildRegistry().all()
      .map((c) => c.verb)
      // `help` itself is the thing being printed, and `start` is documented in
      // the USAGE block above the sections rather than listed as a command.
      .filter((v) => v !== "help" && v !== "start")
      .filter((v) => !help.includes(v));
    expect(missing).toEqual([]);
  });

  test("every verb in VERBS appears too — the table and the help agree", () => {
    const help = renderHelp();
    const missing = Object.keys(VERBS)
      .filter((v) => v !== "help" && v !== "start")
      .filter((v) => !help.includes(v));
    expect(missing).toEqual([]);
  });

  test("self-check: the probe can actually detect an absent verb", () => {
    // Guards against the assertion passing because `help` is empty, or because
    // `includes` is matching something unrelated. A verb nobody declared must
    // come back missing.
    const help = renderHelp();
    expect(help.length).toBeGreaterThan(200);
    expect(help.includes("definitely-not-a-verb")).toBe(false);
  });

  test("plugins specifically — the verb that exposed this gap", () => {
    expect(renderHelp()).toContain("plugins");
  });
});

import { test, expect, describe } from "bun:test";
import { buildRegistry } from "./buildRegistry.ts";
import { VERBS, verbsWithSubcommands, isFlagShaped, type Verb } from "../domain/Verbs.ts";
import { CompletionCommand } from "./commands/CompletionCommand.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import type { Context } from "./Context.ts";

/**
 * #101 — `Verbs.ts`'s `subcommands` was a THIRD, uncross-checked copy of each
 * verb's subcommand list.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Verbs.ts`'s header has claimed since the TS port that "all three surfaces
 * (dispatch / completion / --help) [are] generated from this map." Two were.
 * Completion was a hand-written `case` block in CompletionCommand.ts, and
 * `subcommands` itself was maintained by hand with nothing comparing it to
 * the dispatcher that actually accepts subverbs. The result, found while
 * reviewing #100:
 *
 *   - `browser-bridge` declared ["up","down"]; `status` shipped in #93.
 *   - `team` declared 4 of its 6; `dir` was missing from FIVE places at once
 *     (this map, the summary prose, the verb's usage block, the
 *     unknown-subcommand error one line below the gate that accepted it, and
 *     `printSubverbUsage`'s switch — so `team dir --help` hit a `default:`
 *     branch commented "should be unreachable" and printed the general usage
 *     to STDERR with zero bytes on stdout).
 *   - `features`/`profiles` had no `subcommands` key at all despite accepting
 *     four, so `dridock --help` listed none of them.
 *   - `host-agent`'s usage advertised `[status|stop]` — a `stop` that has
 *     never been accepted — which is character-for-character the defect
 *     UsageSubverbs.test.ts's own header cites as its reason for existing,
 *     still live in a second file.
 *   - `framework-bugs`'s usage advertised `show` and `resolve`, neither
 *     accepted, while its own `--help` branch nine lines below printed the
 *     correct `[list|clear]`.
 *   - The completion block was missing `status` and `update-cli`, and had no
 *     arm at all for `team` or `plugins` — two verbs that simply did not
 *     tab-complete.
 *
 * Every one of those was invisible to the existing enforcement for the same
 * reason: UsageSubverbs.test.ts and HelpConformance.test.ts iterate commands
 * that DECLARE a `subverbs` array, and the drifted verbs declared none. A
 * check that skips exactly the broken cases reports success while verifying
 * nothing — the vacuously-green shape this repo keeps paying for. So the
 * first test below is the one that matters: it requires the declaration to
 * exist before anything else can be compared.
 */

const registry = buildRegistry();
const byVerb = new Map(registry.all().map((c) => [c.verb as string, c]));

/** Non-flag entries — the ones that name a subverb rather than a flag. */
function subverbShaped(subs: readonly string[]): readonly string[] {
  return subs.filter((s) => !isFlagShaped(s));
}

describe("#101 the check itself is not vacuous", () => {
  test("the registry is populated and the verb map has subcommand entries", () => {
    expect(registry.all().length).toBeGreaterThan(20);
    expect(verbsWithSubcommands().length).toBeGreaterThan(8);
  });

  test("at least one verb carries flag-shaped subcommands, so that branch is exercised", () => {
    // `destroy --purge`, `migrate --all`, `checkversion --all`. If this ever
    // hits zero, `subverbShaped` is filtering nothing and the flag carve-out
    // below would silently stop being tested.
    const withFlags = verbsWithSubcommands().filter(([, subs]) => subs.some(isFlagShaped));
    expect(withFlags.length).toBeGreaterThan(0);
  });
});

describe("#101 every verb with subverb-shaped subcommands declares them", () => {
  // THE anti-vacuity test. Without this, the cross-check below silently
  // skips any verb whose command has no `subverbs` array — which was every
  // verb that was actually wrong.
  for (const [verb, subs] of verbsWithSubcommands()) {
    const named = subverbShaped(subs);
    if (named.length === 0) continue; // flag-only verbs: nothing to declare
    test(`${verb} declares a subverbs array`, () => {
      const cmd = byVerb.get(verb);
      expect(cmd, `${verb} is in VERBS but not registered`).toBeDefined();
      expect(
        cmd!.subverbs,
        `${verb}: Verbs.ts lists subcommands [${named.join(", ")}] but the command declares no ` +
        `subverbs array — so UsageSubverbs/HelpConformance skip it and nothing checks its help. ` +
        `Declare them on the Command.`,
      ).toBeDefined();
    });
  }
});

describe("#101 Verbs.ts subcommands ≡ the command's declared subverbs", () => {
  for (const [verb, subs] of verbsWithSubcommands()) {
    const named = subverbShaped(subs);
    if (named.length === 0) continue;
    test(`${verb}: both directions agree`, () => {
      const cmd = byVerb.get(verb);
      if (cmd?.subverbs === undefined) return; // reported by the test above
      const declared = cmd.subverbs.map((s) => s.name);

      const missingFromVerbs = declared.filter((d) => !named.includes(d));
      expect(
        missingFromVerbs,
        `${verb}: the command accepts [${missingFromVerbs.join(", ")}] but Verbs.ts omits them — ` +
        `they will be absent from 'dridock --help' and from tab-completion. This is the ` +
        `browser-bridge/status and harness/update-cli shape.`,
      ).toEqual([]);

      const missingFromCommand = named.filter((n) => !declared.includes(n));
      expect(
        missingFromCommand,
        `${verb}: Verbs.ts advertises [${missingFromCommand.join(", ")}] but the command does not ` +
        `declare them — help and completion offer a subverb the dispatcher will reject. This is ` +
        `the host-agent/stop shape.`,
      ).toEqual([]);
    });
  }
});

describe("#101 flag-shaped subcommands are not declared as subverbs", () => {
  test("no command declares a subverb starting with '-'", () => {
    // `destroy --purge` belongs in `subcommands` (completion should offer
    // it) but must not be a `subverbs` entry: there is no
    // `dridock destroy --purge --help`, and the registry's subverb-help
    // intercept would shadow the flag.
    const offenders: string[] = [];
    for (const cmd of registry.all()) {
      for (const sv of cmd.subverbs ?? []) {
        if (isFlagShaped(sv.name)) offenders.push(`${cmd.verb} ${sv.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("#101 the completion script is generated from Verbs.ts, not hand-written", () => {
  function emitCompletion(): string {
    const out: string[] = [];
    const ctx = {
      fs: new InMemoryFileSystem(),
      env: new EnvResolver({}),
      stdout: { write: (s: string) => { out.push(s); } },
      stderr: { write: () => {} },
      home: "/home/tester",
      cwd: "/home/tester/proj",
      binName: "dridock",
    } as unknown as Context;
    void new CompletionCommand().run(["bash"], ctx);
    return out.join("");
  }

  const script = emitCompletion();

  test("the emitted script is non-empty (guards the assertions below)", () => {
    expect(script).toContain("_dridock_complete");
    expect(script).toContain("COMPREPLY");
  });

  for (const [verb, subs] of verbsWithSubcommands()) {
    test(`${verb} has a completion arm offering exactly its subcommands`, () => {
      // Pinning the FULL list, not just presence of the verb: the old block
      // had a `harness)` arm that offered only `sync` long after
      // `update-cli` shipped, so "an arm exists" was true and useless.
      expect(script).toContain(`${verb})`);
      const arm = script.split("\n").find((l) => l.trim().startsWith(`${verb})`));
      expect(arm, `no completion arm for ${verb}`).toBeDefined();
      expect(arm!).toContain(`-W "${subs.join(" ")}"`);
    });
  }

  test("every verb in VERBS is offered at the top level", () => {
    for (const verb of Object.keys(VERBS) as Verb[]) {
      expect(script).toContain(verb);
    }
  });
});

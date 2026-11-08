import { test, expect, describe } from "bun:test";
import { buildRegistry } from "./buildRegistry.ts";

/**
 * Every subverb a command ADVERTISES must be one its dispatcher ACCEPTS.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dridock browser-bridge --help` printed `[status|stop]`. Neither verb has
 * ever existed — the dispatcher only accepts `up|down`. So the help text told
 * the reader to type commands that get rejected, and had done since the
 * command was ported from wrapper.sh.
 *
 * #60 made `usage` a REQUIRED field so every verb documents itself. Required
 * is not the same as correct: nothing checked that the documentation matched
 * the code, so the field could be confidently wrong forever. Alan found this
 * one by reading `--help` and then typing what it said.
 *
 * Two directions are checked, because each hides a different lie:
 *   - a declared subverb the dispatcher rejects  → help sends you somewhere broken
 *   - a verb named in `usage` prose that is neither declared nor accepted
 *
 * Deliberately driven off the REAL registry rather than a hand-maintained
 * list, so a newly registered command is covered the moment it is wired in.
 */

/** Verbs whose usage prose mentions a word that looks like a subverb but
 *  deliberately isn't one, with the reason. Keeping this explicit means a
 *  genuine drift can't hide behind a blanket exemption. */
const PROSE_ALLOWLIST: Record<string, readonly string[]> = {
  // Documents the ABSENCE of a status verb and points at the issue tracking it.
  "browser-bridge": ["status"],
};

describe("CLI — advertised subverbs are accepted by their dispatcher", () => {
  const registry = buildRegistry();
  const withSubverbs = registry.all().filter((c) => c.subverbs !== undefined && c.subverbs.length > 0);

  test("the registry actually yields commands (guards a vacuously-green suite)", () => {
    // An enforcement test that enumerates nothing reports success while
    // checking nothing — the failure mode this project keeps re-hitting.
    expect(registry.all().length).toBeGreaterThan(10);
    expect(withSubverbs.length).toBeGreaterThan(0);
  });

  for (const cmd of withSubverbs) {
    test(`${cmd.verb}: every declared subverb appears in its own usage text`, () => {
      // Commands whose usage uses the `<subverb>` placeholder delegate to
      // per-subverb help (`dridock consult <subverb> --help`) — that is the
      // #60 pattern working as designed, not an omission, so enumerating the
      // names in the top line would duplicate a list that already exists.
      if (/<subverb>/.test(cmd.usage)) return;
      // Otherwise: a subverb that is real but undocumented is undiscoverable.
      const missing = cmd.subverbs!
        .map((s) => s.name)
        .filter((name) => !new RegExp(`\\b${name}\\b`).test(cmd.usage));
      expect(missing, `${cmd.verb}: declared but absent from usage: ${missing.join(", ")}`).toEqual([]);
    });

    test(`${cmd.verb}: usage names no subverb-shaped word that isn't declared`, () => {
      // Catches the browser-bridge shape exactly: `[status|stop]` in the
      // usage line, neither declared nor accepted.
      const declared = new Set(cmd.subverbs!.map((s) => s.name));
      const allowed = new Set(PROSE_ALLOWLIST[cmd.verb] ?? []);
      // Only PIPE GROUPS (`[a|b|c]`) count as "advertising a verb list". A
      // bare bracket is a placeholder — `[args]`, `[--flag]` — and flagging
      // those produced false positives on the first run. A check that cries
      // wolf on ordinary usage text gets switched off, which is how
      // enforcement dies.
      const synopsis = cmd.usage.split("\n")[0] ?? "";
      const candidates = [...synopsis.matchAll(/\[([a-z][a-z|-]*\|[a-z|-]+)\]/g)]
        .flatMap((m) => m[1]!.split("|"))
        .filter((w) => w.length > 1);
      const undeclared = candidates.filter((c) => !declared.has(c) && !allowed.has(c));
      expect(
        undeclared,
        `${cmd.verb}: usage advertises ${undeclared.join(", ")} — not declared in subverbs. ` +
        `Either implement it, drop it from the usage line, or add it to PROSE_ALLOWLIST with a reason.`,
      ).toEqual([]);
    });
  }

  test("every PROSE_ALLOWLIST entry still refers to a registered verb", () => {
    // A stale exemption silently widens the hole it was carved for.
    const verbs = new Set(registry.all().map((c) => c.verb as string));
    const dead = Object.keys(PROSE_ALLOWLIST).filter((v) => !verbs.has(v));
    expect(dead, `allowlist entries for unregistered verbs (remove them): ${dead.join(", ")}`).toEqual([]);
  });
});

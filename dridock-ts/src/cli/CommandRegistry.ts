import type { Command } from "./Command.ts";
import type { Context } from "./Context.ts";
import { isKnownVerb, allVerbNames, VERBS, type Verb } from "../domain/Verbs.ts";
import { UnknownVerbError } from "../domain/errors.ts";

/**
 * The top-level dispatcher. Ports wrapper.sh's main `case "${1:-}" in ...`
 * block to a Map lookup + typed rejection. Every legitimate verb is
 * registered here; every bareword first-arg that isn't a verb (and isn't a
 * flag) throws `UnknownVerbError` — matches the 3.3.7 fix (`dridock chrome`
 * → exit 1 with a clear message, no VM setup).
 */
export class CommandRegistry {
  private readonly commands = new Map<Verb, Command>();

  /** Register a command. Throws if the verb is already taken (bug — two
   *  commands claiming the same verb is a wiring mistake, not a
   *  runtime-recoverable situation). */
  register(cmd: Command): void {
    if (this.commands.has(cmd.verb)) {
      throw new Error(`CommandRegistry: verb '${cmd.verb}' is already registered`);
    }
    this.commands.set(cmd.verb, cmd);
  }

  /** True if this registry has a command for the verb. */
  has(verb: string): verb is Verb {
    return isKnownVerb(verb) && this.commands.has(verb);
  }

  /** Verbs that are enumerated in `VERBS` but haven't been implemented in
   *  TS yet — during the phased port, `main.ts` shells out to wrapper.sh
   *  for these. Empty once Phase 5 lands. */
  unimplementedVerbs(): readonly Verb[] {
    return allVerbNames().filter((v) => !this.commands.has(v));
  }

  /**
   * Dispatch a full argv slice (post-binary — argv[0] is the verb).
   *
   * Handles the four shapes wrapper.sh's dispatch does:
   *   1. Empty → banner (existing 2.24.0 #12 behavior: version + hint).
   *   2. Starts with `-` → flag mode (falls through to interactive launch).
   *      For Phase 2 that's not implemented yet; returns exit 0 with a note.
   *   3. Known verb → dispatch to the registered Command.
   *   4. Unknown bareword → `UnknownVerbError`, exit 1 (the 3.3.7 fix).
   */
  async dispatch(argv: readonly string[], ctx: Context): Promise<number> {
    const verb = argv[0];

    // Empty first arg → the "bare `dridock`" banner from #12 / 2.24.0.
    // (Phase 2 stops here; Phase 4 wires launch when the user actually types
    // `dridock start`.)
    if (verb === undefined || verb === "") {
      this.writeBanner(ctx);
      return 0;
    }

    // Flag first-arg → passthrough to the eventual interactive-launch path.
    // Not implemented in Phase 2; guarded here so the "unknown verb" branch
    // doesn't accidentally reject legit `dridock -p '…'` invocations.
    if (verb.startsWith("-")) {
      ctx.stderr.write(`dridock-ts (Phase 2): flag passthrough not implemented yet — use the bash wrapper for '${verb}' invocations\n`);
      return 2;
    }

    if (!isKnownVerb(verb)) {
      throw new UnknownVerbError(verb);
    }

    const cmd = this.commands.get(verb);
    if (cmd === undefined) {
      // Known verb but no command registered yet — shell out to bash wrapper
      // during the phased port. Phase 5 removes this branch entirely.
      ctx.stderr.write(`dridock-ts (Phase 2): '${verb}' not yet ported — use the bash wrapper\n`);
      return 2;
    }

    return await cmd.run(argv.slice(1), ctx);
  }

  private writeBanner(ctx: Context): void {
    const versionSpec = VERBS.version.summary;
    ctx.stdout.write(`dridock-ts (Phase 2 — parallel to wrapper.sh)\n\n`);
    ctx.stdout.write(`  ${ctx.binName} version              ${versionSpec}\n`);
    ctx.stdout.write(`  ${ctx.binName} help                 full help\n`);
    ctx.stdout.write(`  (use the bash wrapper for interactive/programmatic launch until Phase 4 lands)\n`);
  }
}

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
  /** Every registered command, for the #60 help-conformance test. */
  all(): ReadonlyArray<Command> {
    return [...this.commands.values()];
  }

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

    // Flag first-arg → auto-invoke `start` with the whole argv. Bash
    // wrapper does the same via its `case` fall-through: any bareword
    // that isn't a management verb reaches the start path.
    // Matches user expectation for `dridock -p '…'` and `dridock --help`.
    if (verb.startsWith("-")) {
      // --help / -h at top level → StartCommand doesn't handle these;
      // route to the help verb explicitly.
      if (verb === "--help" || verb === "-h") {
        const help = this.commands.get("help" as Verb);
        if (help !== undefined) return await help.run(argv.slice(1), ctx);
      }
      // -v / --version → route to VersionCommand explicitly BEFORE
      // falling through to `start`. Rationale (spec #57): the version
      // is metadata about the installed binary — asking for it must not
      // require a project dir. Without this intercept, `dridock -v`
      // in any non-project cwd fell through to `start`, which then
      // errored with "no dridock project here — run 'dridock
      // bootstrap' or 'cd' into one." The version query worked from
      // inside a project (start's flow tolerated it) but never from
      // outside — making it impossible to check the installed version
      // for e.g. host↔image drift diagnosis. Now works from anywhere.
      if (verb === "-v" || verb === "--version") {
        const version = this.commands.get("version" as Verb);
        if (version !== undefined) return await version.run(argv.slice(1), ctx);
      }
      const start = this.commands.get("start" as Verb);
      if (start === undefined) {
        // Fresh compile-registry case — nothing to fall through to.
        throw new UnknownVerbError(verb);
      }
      return await start.run(argv, ctx);
    }

    if (!isKnownVerb(verb)) {
      throw new UnknownVerbError(verb);
    }

    const cmd = this.commands.get(verb);
    if (cmd === undefined) {
      // Every known verb should have a Command registered post-P4e.
      // Reaching this branch means the composition root (main.ts's
      // buildRegistry) missed a verb — programmer error, not runtime.
      throw new Error(`CommandRegistry: verb '${verb}' known but no command registered (composition-root bug — check main.ts buildRegistry)`);
    }

    const rest = argv.slice(1);

    // ── central --help (#60) ────────────────────────────────────────
    // Handled HERE, before the command's own parser runs, so help works
    // uniformly for all 31 registrations instead of the 11 that had
    // hand-rolled it. A framework would have given us this for free;
    // this is the one line of it we actually needed.
    //
    // FIRST POSITION ONLY, deliberately. `start` forwards its args to
    // claude, so intercepting a `--help` anywhere in the slice would
    // swallow one meant for the inner process. As the first arg it is
    // unambiguously addressed to dridock.
    if (rest[0] === "--help" || rest[0] === "-h") {
      ctx.stdout.write(cmd.usage.endsWith("\n") ? cmd.usage : cmd.usage + "\n");
      return 0;
    }

    // `<verb> <subverb> --help` — same source of truth as the verb's own
    // subverb table, so the two can't drift.
    if ((rest[1] === "--help" || rest[1] === "-h") && cmd.subverbs !== undefined) {
      const sub = cmd.subverbs.find((s) => s.name === rest[0]);
      if (sub !== undefined) {
        ctx.stdout.write(`${sub.synopsis.replace(/\n$/, "")}\n`);
        return 0;
      }
    }

    return await cmd.run(rest, ctx);
  }

  private writeBanner(ctx: Context): void {
    const versionSpec = VERBS.version.summary;
    ctx.stdout.write(`dridock\n\n`);
    ctx.stdout.write(`  ${ctx.binName} version              ${versionSpec}\n`);
    ctx.stdout.write(`  ${ctx.binName} start                start/attach the claudebot for $PWD\n`);
    ctx.stdout.write(`  ${ctx.binName} help                 full help\n`);
  }
}

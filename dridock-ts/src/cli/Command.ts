import type { Context } from "./Context.ts";
import type { Verb } from "../domain/Verbs.ts";

/**
 * Every dridock verb implements this — one class per verb, registered in
 * `CommandRegistry`. The Bash version had 3300 lines of `case` branches
 * with no shared source of truth; this makes each verb a self-contained
 * unit whose test lives next to it.
 *
 * Contract:
 * - `.verb` matches a key in `VERBS` (typed).
 * - `.run(args, ctx)` returns the process exit code, EXPLICIT. No throws
 *   escape (subclasses of `DridockError` are caught in `main.ts` and
 *   translated to `err.exitCode`).
 * - `args` is the post-verb argv slice — for `dridock migrate --all`,
 *   `args === ["--all"]`.
 * - `.usage` is REQUIRED. Making it part of the interface rather than a
 *   convention is the point of #60: a command physically cannot be
 *   registered without help text, so "new verb ships with no --help"
 *   becomes a compile error instead of something nobody notices. Before
 *   this, 11 of 27 command files mentioned `--help` at all.
 */
export interface Command {
  readonly verb: Verb;
  /**
   * Help text for this verb, printed verbatim by the dispatcher when
   * `-h`/`--help` is the first post-verb argument. One line minimum;
   * multi-line is fine and preferred where the verb takes flags.
   */
  readonly usage: string;
  /**
   * Verbs that dispatch on their own first argument declare their
   * subverbs here, so `dridock <verb> <subverb> --help` renders from the
   * same source as the unknown-subverb error. This is the case that
   * opened #60: `dridock team post --help` fell into post's own parser
   * and hit its unknown-argument branch, printing an error that read
   * like documentation.
   */
  readonly subverbs?: ReadonlyArray<{ readonly name: string; readonly synopsis: string }>;
  /** Post-verb argv slice. Widened to `readonly` so callers with a
   *  frozen argv slice (the Registry's top-level flag passthrough) can
   *  pass through without copying. Commands must not mutate the array. */
  run(args: readonly string[], ctx: Context): Promise<number>;
}

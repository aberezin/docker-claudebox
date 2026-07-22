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
 */
export interface Command {
  readonly verb: Verb;
  run(args: string[], ctx: Context): Promise<number>;
}

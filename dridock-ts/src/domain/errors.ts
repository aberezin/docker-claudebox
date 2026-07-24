/**
 * Base class for every error dridock raises. Callers can `catch (e) { if (e
 * instanceof DridockError) ... }` and get a typed exit code + user-facing
 * message with no ambiguity.
 *
 * Convention: `exitCode` is 1 for "user did something we refuse" and 2 for
 * "the environment is wrong" (missing binary, unreachable daemon, etc.), so a
 * caller shell can `dridock foo || alert` and distinguish user error from
 * environment error. Anything using process.exit should exit via the code on
 * the caught DridockError, never a raw number.
 */
export class DridockError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "DridockError";
    this.exitCode = exitCode;
  }
}

/**
 * A required env var wasn't set. Thrown by `EnvResolver.require`.
 */
export class MissingEnvError extends DridockError {
  readonly canonicalName: string;
  constructor(canonicalName: string) {
    super(`missing required env: DRIDOCK_${canonicalName} (or legacy CLAUDEBOX_${canonicalName} / CLAUDE_${canonicalName})`, 2);
    this.name = "MissingEnvError";
    this.canonicalName = canonicalName;
  }
}

/**
 * User invoked an unknown verb. Thrown by `CommandRegistry.dispatch` — matches
 * the wrapper.sh:2766 fix from 3.3.7 (`❌ unknown dridock verb: 'chrome'`).
 */
export class UnknownVerbError extends DridockError {
  readonly verb: string;
  constructor(verb: string) {
    super(`unknown dridock verb: '${verb}'\n   run 'dridock --help' for the list of valid verbs`, 1);
    this.name = "UnknownVerbError";
    this.verb = verb;
  }
}

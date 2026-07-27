import { MissingEnvError } from "./errors.ts";

/**
 * The three-tier env-var fallback dridock has carried since 3.0:
 *
 *   ${DRIDOCK_X:-${CLAUDEBOX_X:-${CLAUDE_X:-default}}}
 *
 * In bash this pattern was repeated at every read site, and every reader had
 * to remember to write the whole chain (bug #26 — 10 sites in the Python
 * daemons that only had `CLAUDEBOX_X` — was exactly this class of forgetting).
 *
 * Here, one method call. The fallback chain lives in one place. `.require` throws
 * a typed `MissingEnvError` (exit 2) so callers can `catch (MissingEnvError)` if
 * they want to degrade gracefully, or let it bubble to `main` which uses the
 * exit code.
 *
 * Removal in 4.0: the CLAUDEBOX_ and CLAUDE_ tiers go away then; this class's
 * `.get` will only look at DRIDOCK_. Callers don't change.
 */
export class EnvResolver {
  constructor(private readonly env: Record<string, string | undefined>) {}

  /**
   * Returns the first defined value across the three tiers, or the given
   * default (or undefined) if none is set.
   */
  get(name: string, defaultValue?: string): string | undefined {
    return (
      this.env[`DRIDOCK_${name}`] ??
      this.env[`CLAUDEBOX_${name}`] ??
      this.env[`CLAUDE_${name}`] ??
      defaultValue
    );
  }

  /**
   * Same as `.get` but throws `MissingEnvError` when the value isn't set on any
   * tier and no default was provided. Use when the caller cannot proceed without.
   */
  require(name: string): string {
    const value = this.get(name);
    if (value === undefined || value === "") throw new MissingEnvError(name);
    return value;
  }

  /**
   * The underlying env record — for callers that need a raw env map
   * rather than the tiered `.get()` lookup. Two audiences:
   *
   *   1. Path resolvers (`xdgRoot`, `stateHome`) that read
   *      **`XDG_CONFIG_HOME`** — an untiered var with no
   *      `DRIDOCK_XDG_CONFIG_HOME` alternative. `.get("XDG_CONFIG_HOME")`
   *      would return undefined because it prefixes with `DRIDOCK_`.
   *   2. Deps that carry env forward to services with their own env
   *      contracts (MachineConfig, BridgeStateReader, OrphanSessionScanner,
   *      GithubWatchSource).
   *
   * Adding this method closes #51: pre-fix, those 17 call sites read
   * `process.env` directly, bypassing the injected `ctx.env` and letting
   * a real `XDG_CONFIG_HOME` leak into every test (fine on Linux where
   * XDG is unset, 29 test failures on macOS).
   */
  raw(): Record<string, string | undefined> {
    return this.env;
  }

  /**
   * Boolean truthy check ("1" / "true" / "yes" / "on" — matches the bash
   * `case "..." in 1|true|yes|on)` idiom used throughout wrapper.sh).
   */
  bool(name: string): boolean {
    const value = this.get(name);
    if (value === undefined) return false;
    switch (value.toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
        return true;
      default:
        return false;
    }
  }
}

import { MissingEnvError } from "./errors.ts";

/**
 * Reads dridock's own settings from the environment: `DRIDOCK_<NAME>`.
 *
 * **Single tier as of 5.0.0.** From 3.0 to 4.x this was a three-deep chain
 * (`DRIDOCK_X` → `CLAUDEBOX_X` → `CLAUDE_X`) carrying the 2.x and upstream-1.x
 * names. Those are gone; see docs/roadmap.md. Setting a `CLAUDEBOX_*` name now
 * does nothing, which is the point — the tiers made it impossible for the test
 * suite to tell which name a green run had actually exercised (#82).
 *
 * Centralising the read still earns its keep: in bash the chain was retyped at
 * every site and #26 found ten Python reads that had silently kept only one
 * tier. One method, one definition of where a setting comes from.
 *
 * Scope note: this class governs **dridock's** settings only. Genuine upstream
 * Claude Code variables — `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`,
 * `ANTHROPIC_API_KEY` — are read by name elsewhere and are untouched by the
 * 5.0 removal.
 *
 * `.require` throws a typed `MissingEnvError` (exit 2) so callers can catch it
 * or let it bubble to `main`, which uses the exit code.
 */
export class EnvResolver {
  constructor(private readonly env: Record<string, string | undefined>) {}

  /**
   * Returns `DRIDOCK_<name>`, or the given default (or undefined) if unset.
   *
   * Single tier as of 5.0.0. The legacy `CLAUDEBOX_` (2.x) and `CLAUDE_` (1.x
   * upstream) fallbacks are GONE — see docs/roadmap.md. Note this only ever
   * governed dridock's OWN settings: genuinely upstream Claude Code vars
   * (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`) were never read through
   * here and are unaffected.
   */
  get(name: string, defaultValue?: string): string | undefined {
    return this.env[`DRIDOCK_${name}`] ?? defaultValue;
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

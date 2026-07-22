import { DridockError } from "./errors.ts";

/**
 * Semver + host↔image contract. In bash the wrapper's version was a plain
 * string variable + `sed` on VERSION; the checkversion verb compared strings
 * with `sort -V`. Here: parsed once, compared semantically.
 *
 * See docs/versioning.md for the release process this class encodes.
 */

export type Severity = "major" | "minor" | "patch" | "same";

/**
 * A parsed semantic version. `raw` preserves whatever the caller passed for
 * error messages / log lines.
 */
export class Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;

  constructor(major: number, minor: number, patch: number, raw?: string) {
    if (!Number.isInteger(major) || major < 0) throw new DridockError(`invalid major: ${major}`);
    if (!Number.isInteger(minor) || minor < 0) throw new DridockError(`invalid minor: ${minor}`);
    if (!Number.isInteger(patch) || patch < 0) throw new DridockError(`invalid patch: ${patch}`);
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.raw = raw ?? `${major}.${minor}.${patch}`;
  }

  /**
   * Parse a `MAJOR.MINOR.PATCH` string. Tolerates a leading `v` (`v3.3.7` →
   * `3.3.7`) and trailing whitespace/newline (VERSION file has a trailing \n).
   * Throws DridockError on anything else — no silent parsing.
   */
  static parse(input: string): Version {
    const trimmed = input.trim().replace(/^v/, "");
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
    if (!match) throw new DridockError(`invalid semver: '${input}' (expected MAJOR.MINOR.PATCH)`);
    return new Version(Number(match[1]), Number(match[2]), Number(match[3]), input.trim());
  }

  /**
   * Bash-parity permissive parse (ports cb_semver_cmp's handling of
   * `0.1.0-rc1` → treats non-digit trailing chars per-component as if the
   * digits alone were the value, missing fields default to 0). Never
   * throws — invalid input parses as 0.0.0. Match bash's silent behavior
   * so a weirdly-stamped image doesn't blow up checkversion.
   */
  static parseLoose(input: string): Version {
    const trimmed = input.trim().replace(/^v/, "");
    const parts = trimmed.split(".");
    const num = (s: string | undefined): number => {
      if (s === undefined) return 0;
      const leading = s.match(/^(\d+)/);
      return leading ? Number(leading[1]) : 0;
    };
    return new Version(num(parts[0]), num(parts[1]), num(parts[2]), input.trim());
  }

  toString(): string { return `${this.major}.${this.minor}.${this.patch}`; }

  /**
   * Structural compare — returns `gt`/`lt`/`eq` to match wrapper.sh's
   * cb_semver_cmp output vocabulary directly.
   */
  compareTo(other: Version): "gt" | "lt" | "eq" {
    if (this.major !== other.major) return this.major < other.major ? "lt" : "gt";
    if (this.minor !== other.minor) return this.minor < other.minor ? "lt" : "gt";
    if (this.patch !== other.patch) return this.patch < other.patch ? "lt" : "gt";
    return "eq";
  }

  /**
   * Highest bump severity between this and another version — used by
   * `checkversion` to decide the message ("🔴 MAJOR behind" vs "🟡 PATCH
   * behind"). Symmetric: a.skewSeverity(b) === b.skewSeverity(a).
   */
  skewSeverity(other: Version): Severity {
    if (this.major !== other.major) return "major";
    if (this.minor !== other.minor) return "minor";
    if (this.patch !== other.patch) return "patch";
    return "same";
  }

  /** Static form kept for callers that prefer a symmetric two-arg call. */
  static skewSeverity(a: Version, b: Version): Severity { return a.skewSeverity(b); }
}

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

  toString(): string { return `${this.major}.${this.minor}.${this.patch}`; }

  /**
   * Structural compare: -1 if this < other, 0 if equal, +1 if this > other.
   */
  compareTo(other: Version): -1 | 0 | 1 {
    if (this.major !== other.major) return this.major < other.major ? -1 : 1;
    if (this.minor !== other.minor) return this.minor < other.minor ? -1 : 1;
    if (this.patch !== other.patch) return this.patch < other.patch ? -1 : 1;
    return 0;
  }

  /**
   * Highest bump severity between two versions — used by `checkversion` to
   * decide the message ("🔴 MAJOR behind" vs "🟡 PATCH behind"). Symmetric:
   * skewSeverity(a, b) === skewSeverity(b, a).
   */
  static skewSeverity(a: Version, b: Version): Severity {
    if (a.major !== b.major) return "major";
    if (a.minor !== b.minor) return "minor";
    if (a.patch !== b.patch) return "patch";
    return "same";
  }
}

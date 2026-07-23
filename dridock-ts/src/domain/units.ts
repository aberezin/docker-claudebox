import { DridockError } from "./errors.ts";

/**
 * Byte-size parsing and rendering — ports `cb_num` (strip suffix → integer)
 * and `cb_h` (bytes → human) from wrapper.sh.
 *
 * Bash's `cb_num` matched only the digits; `cb_h` used awk. Here they're both
 * one-liners with actual overflow/precision safety (bash integers are 64-bit
 * but bash arithmetic silently overflows on `((huge * 1024))`; JS numbers use
 * IEEE 754 which is safe to `Number.MAX_SAFE_INTEGER` = 2^53).
 */

/**
 * Parse `8GiB` → 8, `1.5TiB` → 1.5. Suffix-agnostic; returns the numeric part
 * only, matching bash `cb_num`. Throws on unparseable input (bash silently
 * returned "").
 */
export function cbNum(input: string): number {
  const match = /^(\d+(?:\.\d+)?)/.exec(input.trim());
  if (!match) throw new DridockError(`cbNum: unparseable numeric input: '${input}'`);
  return Number(match[1]);
}

const UNITS = ["B", "K", "M", "G", "T", "P"] as const;

/**
 * `cbH(1073741824)` → `"1G"`. Empty/zero input → `"0B"`. Byte-for-byte
 * bash-parity with `cb_h` at wrapper.sh:850: single-letter units
 * (B/K/M/G/T/P — NOT the "KiB/MiB" long form), NO space between number
 * and unit, integer values print without decimals, non-integer with one
 * decimal (`8G`, `1.5K`, `1023B`).
 *
 * Arfy #38 P4c pass 2 B3 cosmetic: unit format was `28.1 GiB` — this
 * fixes to `28.1G`.
 */
export function cbH(bytes?: number): string {
  if (bytes === undefined || bytes === 0 || !Number.isFinite(bytes)) return "0B";
  if (bytes < 0) throw new DridockError(`cbH: negative bytes: ${bytes}`);

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rendered = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${rendered}${UNITS[unit]}`;
}

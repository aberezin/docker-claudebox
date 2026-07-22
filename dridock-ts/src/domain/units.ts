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

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * `cbH(1073741824)` → `"1 GiB"`. Empty/zero input → `"0B"` (matches bash's
 * `cb_h` behavior of `"$( ... echo 0B )"`).
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

  // Match wrapper.sh's rendering: whole numbers as `N Unit`, non-whole with
  // one decimal place. `1.5 KiB`, `8 GiB`, `1023 B`.
  const rendered = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit === 0 ? `${rendered}B` : `${rendered} ${UNITS[unit]}`;
}

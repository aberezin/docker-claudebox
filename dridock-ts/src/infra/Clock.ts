/**
 * A time source. Ported so migrators/tests can freeze time when they
 * need a deterministic `.legacy-<ts>` suffix. Real impl uses
 * `new Date()`; tests use `FrozenClock`.
 */
export interface Clock {
  /** UTC-ish `YYYYMMDDHHMMSS` string — same shape as bash `date +%Y%m%d%H%M%S`. */
  timestamp(): string;
}

export class RealClock implements Clock {
  timestamp(): string {
    const now = new Date();
    const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
}

/** Test double — always returns the same string. */
export class FrozenClock implements Clock {
  constructor(private readonly value: string = "20260722000000") {}
  timestamp(): string { return this.value; }
}

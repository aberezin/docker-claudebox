import type { TextWriter } from "../cli/Context.ts";

/**
 * A long-running phase reporter (#48).
 *
 * `ImageEnsureService`'s `docker save | docker load` takes 15-45s for the
 * full image with both stderr streams swallowed, so a cold-path `start`
 * printed "🚀 dridock start", then nothing at all, then eventually
 * "🔧 starting container". #48 fixed the surrounding phases; this is the
 * window it left silent.
 *
 * Deliberately an interface rather than the Spinner class directly: the
 * service should say "this phase is long", not know about terminals.
 */
export interface ProgressResult {
  /** False marks the phase as failed — the final line gets ✗, not ✓.
   *  Defaults to true. Reporting every phase as a success regardless of
   *  outcome would be a cheerful lie on the one path that matters. */
  readonly ok?: boolean;
  /** Replaces the label in the final line. */
  readonly summary?: string;
}

export interface Progress {
  /**
   * Announce the start of a slow phase. Returns the completion callback —
   * call it exactly once, and ALWAYS (a `finally`), or the line is left
   * dangling and the next write lands mid-spinner.
   */
  begin(label: string): (result?: ProgressResult) => void;
}

/** Does nothing. The default, so a caller that supplies no Progress
 *  behaves exactly as before this issue. */
export const NULL_PROGRESS: Progress = { begin: () => () => {} };

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_INTERVAL_MS = 100;

export interface SpinnerDeps {
  readonly out: TextWriter;
  /**
   * Whether `out` is an interactive terminal. When false we emit NO
   * animation frames — `\r`-overwriting into a pipe or a log file produces
   * a single unreadable line — but we still print the completion line, so a
   * non-interactive run records that a reseed happened and how long it took.
   * Silence would be the easier choice and the worse one.
   */
  readonly isTty: boolean;
  /** Monotonic-ish milliseconds. Injected so tests are deterministic. */
  readonly now: () => number;
  readonly intervalMs?: number;
  /**
   * Timer seam. Real impl is setInterval; tests drive frames by calling
   * the returned Spinner's `tick()` directly and pass a no-op scheduler,
   * which keeps the suite free of fake timers.
   */
  readonly schedule?: (fn: () => void, ms: number) => { cancel: () => void };
}

export class Spinner implements Progress {
  private frame = 0;
  private startedAt = 0;
  private label = "";
  private active = false;
  private timer?: { cancel: () => void };

  constructor(private readonly deps: SpinnerDeps) {}

  begin(label: string): (result?: ProgressResult) => void {
    // Re-entrancy guard: a second begin() while one is live would leave the
    // first line dangling and interleave two animations on one row.
    if (this.active) return () => {};
    this.active = true;
    this.label = label;
    this.startedAt = this.deps.now();
    this.frame = 0;

    if (this.deps.isTty) {
      this.render();
      const every = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
      const schedule = this.deps.schedule;
      if (schedule !== undefined) this.timer = schedule(() => { this.tick(); }, every);
    }

    let ended = false;
    return (result?: ProgressResult) => {
      // Idempotent: a caller with both an early return and a finally would
      // otherwise print two completion lines.
      if (ended) return;
      ended = true;
      this.end(result);
    };
  }

  /** Render one frame. Public so tests advance the animation deterministically. */
  tick(): void {
    if (!this.active || !this.deps.isTty) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    this.render();
  }

  private elapsedSec(): number {
    return Math.max(0, Math.round((this.deps.now() - this.startedAt) / 1000));
  }

  private render(): void {
    // \r returns to column 0; \x1b[K clears to end of line so a shorter
    // frame can't leave tail characters from a longer previous one.
    this.deps.out.write(`\r\x1b[K${FRAMES[this.frame]} ${this.label} (${this.elapsedSec()}s)`);
  }

  private end(result?: ProgressResult): void {
    const secs = this.elapsedSec();
    this.active = false;
    this.timer?.cancel();
    this.timer = undefined;
    // Clear the animation row before the final line, so the completion
    // message starts at column 0 and the next status line is unaffected.
    if (this.deps.isTty) this.deps.out.write("\r\x1b[K");
    const mark = result?.ok === false ? "✗" : "✓";
    this.deps.out.write(`${mark} ${result?.summary ?? this.label} (${secs}s)\n`);
  }
}

/** Production wiring: real timer, real clock. */
export function realSpinner(out: TextWriter, isTty: boolean): Spinner {
  return new Spinner({
    out,
    isTty,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = setInterval(fn, ms);
      // Don't hold the event loop open on our account.
      (id as unknown as { unref?: () => void }).unref?.();
      return { cancel: () => { clearInterval(id); } };
    },
  });
}

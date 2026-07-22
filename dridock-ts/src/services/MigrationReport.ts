/**
 * A migrator's outcome, typed so the audit rule (visible warning + non-zero
 * rc on any skip) is enforceable by the compiler instead of by memory:
 *
 *   - `applied`   : did the work → visible ✓ line, rc contribution = 0
 *   - `nothing-to-do` : legacy dir wasn't present → silent, rc contribution = 0
 *   - `merged`    : merged clean entries into an existing dst → ✓ line, rc = 0
 *   - `skipped-conflict` : split-brain, split-brain-cdp, live-chrome, etc.
 *                          → ⚠ line to stderr, rc contribution = 1
 *
 * Any migrator that returns a report must return one of these — you cannot
 * "return true" and quietly do nothing. The renderer + rc-accumulator use
 * the discriminant to fire the right side effect for each kind.
 */
export type MigrationOutcome =
  | { readonly kind: "nothing-to-do" }
  | { readonly kind: "applied"; readonly from: string; readonly to: string; readonly note?: string }
  | { readonly kind: "merged"; readonly from: string; readonly to: string; readonly cleanCount: number; readonly collisionCount?: number; readonly collidedSuffix?: string }
  | { readonly kind: "skipped-conflict"; readonly reason: string; readonly hints: readonly string[] };

export interface MigrationReport {
  /** Short label — "workspace", "data-dir(<id>)", "machine-config", "state:cdp"... */
  readonly item: string;
  readonly outcome: MigrationOutcome;
}

/** True iff the outcome contributes 1 to the accumulated rc AND fires a stderr warning. */
export function isSkip(o: MigrationOutcome): boolean {
  return o.kind === "skipped-conflict" || (o.kind === "merged" && (o.collisionCount ?? 0) > 0);
}

/** The final exit code from a run of migrators. 0 iff no skipped-conflicts or merged-with-collision. */
export function accumulateRc(reports: readonly MigrationReport[]): number {
  return reports.some((r) => isSkip(r.outcome)) ? 1 : 0;
}

/** Every migrator implements this. */
export interface Migrator {
  migrate(): Promise<readonly MigrationReport[]>;
}

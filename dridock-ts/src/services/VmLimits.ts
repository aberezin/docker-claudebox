/**
 * Pure decision function for the VM-count guardrail. Ports
 * cb_vm_limit_decision at wrapper.sh:608 exactly.
 *
 *   - `count >= hard` → deny (refuse to start; user must free one)
 *   - `count >= warn` → warn (start anyway, print advisory)
 *   - else            → ok (silent)
 *
 * Non-numeric inputs return 'ok' (bash's `case "$count$warn$hard" in
 * *[!0-9]*)` guard prevents `[ "$count" -ge "$hard" ]` from crashing on
 * an unparseable machine-config value).
 */
export type VmLimitVerdict = "ok" | "warn" | "deny";

export function decideVmLimit(count: number, warnMax: number, hardMax: number): VmLimitVerdict {
  if (!Number.isFinite(count) || !Number.isFinite(warnMax) || !Number.isFinite(hardMax)) return "ok";
  if (count >= hardMax) return "deny";
  if (count >= warnMax) return "warn";
  return "ok";
}

/** Bash `cb_baked_default` for vm limit fields (wrapper.sh:147-148). */
export const BAKED_WARN_MAX = 3;
export const BAKED_HARD_MAX = 5;

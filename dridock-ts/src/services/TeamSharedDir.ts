/**
 * The team's shared scratch directory — one path both members of a
 * dridock team can reach, across macOS user accounts.
 *
 * WHY THIS EXISTS
 * ---------------
 * dridock teams span OS accounts by design: Arfy runs as `claude-arfy`,
 * Bear under `aberezin`, each with its own colima profile, its own image
 * store, and its own `~/.claude`. That isolation is deliberate, but it
 * leaves the members with no common ground at all — no shared filesystem,
 * no shared docker socket, no shared session registry. Every exchange has
 * had to route through GitHub.
 *
 * WHY NOT `mktemp`, AND WHY NOT $TMPDIR
 * -------------------------------------
 * Both were the obvious first answers and both are wrong here:
 *
 *   - `$TMPDIR` on macOS is PER-USER (`/var/folders/<hash>/T/`). That is
 *     the point of it — it is confidential to the account. Two accounts
 *     get two different paths, so it can never be a rendezvous.
 *
 *   - `mktemp -d` creates `drwx------` (the other account cannot enter)
 *     and, more fundamentally, a RANDOM name. A rendezvous point must be
 *     discoverable by the other side without prior coordination; a random
 *     name has to be published somewhere shared first, which is the very
 *     problem it was supposed to solve.
 *
 * So the path is DETERMINISTIC (derived from the team name) and lives
 * under `/tmp` — on macOS the only cross-account temp that exists
 * (`/private/tmp`, mode 1777, sticky).
 *
 * REAPING
 * -------
 * macOS clears `/tmp` at BOOT (`com.apple.tmp_cleaner.plist`), so nothing
 * here survives a restart — treat everything written here as disposable.
 *
 * What macOS does NOT do is age entries out during uptime: there is no
 * `/etc/periodic/daily/` and no `com.apple.periodic-daily.plist`. On a
 * machine that stays up for a week, a week of files accumulate. That is
 * what `--reap` is for -- not reclaiming space the OS ignores forever,
 * which was the overbroad claim in the first version of this comment.
 *
 * NEVER PUT SECRETS HERE
 * ----------------------
 * Mode 1777 means every local account on the machine can read it. Secrets
 * travel the documented path only: gitignored, chmod-600
 * `.dridock/secrets.env` → per-container sidecars → entrypoint export.
 * This directory is for scratch exchange, never credentials.
 */

/** Default parent for all teams' shared dirs. `/tmp` is a symlink to
 *  `/private/tmp` on macOS; we use `/tmp` because that is the path users
 *  type and both resolve identically. */
export const TEAM_SHARED_ROOT = "/tmp/dridock/teams";

/** Mode for the team dir: world-writable + STICKY, matching `/tmp`
 *  itself. Sticky matters — without it either account could delete the
 *  other's files; with it, only the owner of a file may remove it. */
export const TEAM_DIR_MODE = 0o1777;

/**
 * Absolute path for a team's shared dir. `override` (DRIDOCK_TEAM_DIR)
 * wins when set, so a Linux host or a test can point elsewhere without
 * the /tmp assumption baked in.
 *
 * Throws on a team name that isn't slug-shaped. The roster parser
 * already validates this; re-checking here means a caller that
 * constructs a Roster by hand can't produce a traversing path.
 */
export function teamSharedDir(team: string, override?: string): string {
  if (override !== undefined && override.trim() !== "") return override.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(team)) {
    throw new Error(`invalid team name '${team}' — refusing to build a shared-dir path from it`);
  }
  return `${TEAM_SHARED_ROOT}/${team}`;
}

/** One entry considered for reaping, with the age used to decide. */
export interface ReapCandidate {
  readonly name: string;
  readonly ageDays: number;
}

/**
 * Split entries into those older than `olderThanDays` and those kept.
 *
 * Pure so the age policy is testable without touching a filesystem —
 * the destructive half (actually unlinking) stays in the caller, which
 * is the only place that should be able to delete anything.
 */
export function partitionForReap(
  entries: readonly ReapCandidate[],
  olderThanDays: number,
): { reap: readonly ReapCandidate[]; keep: readonly ReapCandidate[] } {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error(`--older-than must be a non-negative number of days, got '${olderThanDays}'`);
  }
  const reap: ReapCandidate[] = [];
  const keep: ReapCandidate[] = [];
  for (const e of entries) {
    // STRICTLY greater: `--older-than 0` still means "everything that has
    // aged at all", not "everything including what was written this
    // instant by the other member while we were listing".
    (e.ageDays > olderThanDays ? reap : keep).push(e);
  }
  return { reap, keep };
}

import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Report, don't migrate, what a project move still costs (#123/#133,
 * docs/design/path-independence.md § The mount is the exception).
 *
 * The workspace is mounted at its own host path (docker-out-of-docker needs
 * that), and TWO things under the mount are keyed by that path:
 *
 *   - Claude Code's session dir, so `--continue` finds nothing after a move;
 *   - cron's per-job history (#133), which is worse than it sounds: cron runs
 *     `claude -p` with no `--continue` and no `--resume` (cron.py:324), so the
 *     history hint built from the previous run's dir is a scheduled job's ONLY
 *     memory. A job written to compare against yesterday silently starts
 *     answering as if it had never run.
 *
 * Both are written by processes we don't control, so we move neither. We say
 * what happened and give the exact `mv`.
 *
 * ONE record (`last-workspace`) drives both checks on purpose. Two records
 * would mean whichever path ran first consumed its own and left the other
 * silent — a diagnostic suppressed by shared state, the shape CLAUDE.md's
 * current-run rule exists for. So the first start that notices a move reports
 * everything it can see, and the new path is recorded before reporting, so
 * starting again proceeds with a fresh history if that is what the user wants.
 *
 * The CALLER decides the rc: `start` exits 1 (a human is there to act), the
 * cron path warns and keeps launching (#133 — a daemon that refuses to start
 * runs no jobs at all, which is worse than running them without their hint,
 * and there is nobody at the terminal to read the refusal).
 */
export type MovedDir = {
  readonly what: "sessions" | "cron-history";
  readonly from: string;
  readonly to: string;
  readonly entries: number;
};
export type MoveCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "moved"; readonly dirs: readonly MovedDir[]; readonly message: string };

/** Claude Code's project-dir slug: every non-alphanumeric character becomes `-`. */
export function sessionSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * cron.py's slug — a DIFFERENT rule, and the difference is load-bearing:
 * `slugify()` at cron.py:64 collapses RUNS of non-alphanumerics to a single
 * `_` and strips them from both ends, where sessionSlug maps each character
 * to `-`. Using one for the other silently points at a directory that never
 * existed, so the check would find nothing and report nothing.
 *
 * tests/test_cron_slug_mirror.sh pins the two implementations together.
 */
export function cronHistorySlug(path: string): string {
  const s = path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s === "" ? "workspace" : s;
}

export async function checkWorkspaceMove(
  fs: FileSystem,
  opts: {
    readonly stateRoot: string; readonly dataDir: string; readonly root: string; readonly binName: string;
    /** `start` has exited before anything writes; `cron` is already running (#133, Bear review). */
    readonly caller: "start" | "cron";
  },
): Promise<MoveCheck> {
  const record = `${opts.stateRoot}/last-workspace`;
  const prev = (await fs.readTextOrUndefined(record))?.trim();
  if (prev !== opts.root) {
    await fs.mkdirRecursive(opts.stateRoot);
    await fs.writeText(record, `${opts.root}\n`);
  }
  if (prev === undefined || prev === "" || prev === opts.root) return { kind: "ok" };

  // Per directory: report it only when the old one holds something AND the new
  // one does not exist, so the `mv` we print can never clobber.
  const candidates: readonly { what: MovedDir["what"]; from: string; to: string }[] = [
    {
      what: "sessions",
      from: `${opts.dataDir}/projects/${sessionSlug(prev)}`,
      to: `${opts.dataDir}/projects/${sessionSlug(opts.root)}`,
    },
    {
      what: "cron-history",
      from: `${opts.dataDir}/cron/history/${cronHistorySlug(prev)}`,
      to: `${opts.dataDir}/cron/history/${cronHistorySlug(opts.root)}`,
    },
  ];

  const dirs: MovedDir[] = [];
  for (const c of candidates) {
    if (!(await fs.isDirectory(c.from))) continue;
    if (await fs.isDirectory(c.to)) continue;
    let entries = 0;
    try { entries = (await fs.listDir(c.from)).length; } catch { entries = 0; }
    if (entries === 0) continue;
    dirs.push({ ...c, entries });
  }
  if (dirs.length === 0) return { kind: "ok" };

  const plural = (n: number): string => `${n} entr${n === 1 ? "y" : "ies"}`;
  const cron = opts.caller === "cron";

  // ENTRIES, not the directory (#133, Bear review). `mv <old> <new>` is a
  // rename only while <new> doesn't exist; once it does, mv puts <old> INSIDE
  // it as <new>/<old-slug>, silently and with rc 0 — measured — where neither
  // Claude's --continue nor cron's _previous_run_dir looks. The "new one does
  // not exist" check above holds when this RUNS, not when the human ACTS: on
  // the cron path cron has already launched and the first job to fire creates
  // <new>, and even on `start` the user may have started again meanwhile. The
  // entries form is correct either way, and run dirs / transcripts are named
  // by timestamp or session id, so they don't collide.
  const adopt = (d: MovedDir): string => `mkdir -p '${d.to}' && mv '${d.from}'/* '${d.to}'/`;

  let message = cron
    ? `⚠️  this project moved: ${prev} → ${opts.root}\n`
    : `❌ this project moved: ${prev} → ${opts.root}\n`;
  for (const d of dirs) {
    message += d.what === "sessions"
      ? `   Claude keeps session history by directory, so a session here starts with none.\n`
        + `   The old history (${plural(d.entries)}) is still here:\n`
      : `   cron keys each job's history by directory too, and that history is a scheduled\n`
        + `   job's only memory of its last run (cron jobs get no --continue). The old\n`
        + `   history (${plural(d.entries)}) is still here:\n`;
    message += `     ${d.from}\n`;
    message += cron
      ? `   cron has STARTED, so jobs are already writing under the new slug. To keep the\n`
        + `   old history, stop cron, move its entries, then start cron again:\n`
        + `     DRIDOCK_MODE_CRON=1 ${opts.binName} stop\n`
        + `     ${adopt(d)}\n`
      : `   To keep it, move its entries into the new path's slug, then start again:\n`
        + `     ${adopt(d)}\n`;
  }
  message += cron
    ? `   To let it start fresh instead, do nothing — this is only said once.\n`
    : `   To start fresh instead, just run '${opts.binName} start' again (this is only said once).\n`;
  return { kind: "moved", dirs, message };
}

import type { FileSystem } from "../infra/FileSystem.ts";
import { cronModeRequested } from "../cli/commands/CronModeCommand.ts";

/**
 * Per-directory opt-out marker. Drop `.nodridock` in a directory and
 * dridock refuses to launch (start / bootstrap / cron mode / any
 * project-scoped verb) in that directory OR any subdirectory of it.
 *
 * Rationale: users want blast-radius protection. "Never run dridock in
 * my ~/finance/" or "not in this repo" is a real ask — cheaper and
 * more discoverable than remembering the paths yourself. Gitignore the
 * marker if you want the protection to be machine-local.
 *
 * Walk semantics: starts at cwd, walks upward one dir at a time,
 * stopping at $HOME (inclusive) or filesystem root (whichever comes
 * first). $HOME is honored so a global `.nodridock` at ~/ protects the
 * user's entire tree without also protecting other users on multi-user
 * boxes.
 */
export const NO_DRIDOCK_MARKER = ".nodridock";

/**
 * Return the ABSOLUTE PATH of the nearest `.nodridock` marker at cwd
 * or above (up to $HOME or /), or `undefined` if none. The caller
 * decides how to react — this function has no side effects and cannot
 * throw. Pure over the (fs, cwd, home) trio for zero-cost unit tests.
 */
export async function findNoDridockMarker(
  fs: FileSystem,
  cwd: string,
  home: string,
): Promise<string | undefined> {
  // Normalize: strip trailing / (except when cwd is exactly "/").
  let dir = cwd === "/" ? "/" : cwd.replace(/\/+$/, "");
  const normalizedHome = home === "/" ? "/" : home.replace(/\/+$/, "");
  // Safety bound — a hostile path (`.././..`) or a broken adapter should
  // not become an infinite loop. Real filesystems bottom out fast.
  for (let i = 0; i < 1024; i++) {
    const candidate = dir === "/" ? `/${NO_DRIDOCK_MARKER}` : `${dir}/${NO_DRIDOCK_MARKER}`;
    if (await fs.exists(candidate)) return candidate;
    if (dir === "/" || dir === normalizedHome) return undefined;
    const parent = dir.substring(0, dir.lastIndexOf("/"));
    dir = parent === "" ? "/" : parent;
  }
  return undefined;
}

/**
 * The narrow set of invocations `.nodridock` blocks: things that would
 * CREATE or LAUNCH state in / for cwd. Everything else — read-only
 * inspection, cleanup, meta — is deliberately allowed, so a user who
 * marks a tree can still `dridock stop`/`destroy`/`info` an existing
 * project inside it (essential for cleanup and diagnosis).
 *
 *   - Cron mode dispatched   → YES (spawns a container in cwd)
 *   - No args (bareword)     → YES (falls through to start hint)
 *   - First arg starts with `-` (e.g. `-p "…"`) → YES (programmatic
 *     start; bash treats these the same way)
 *   - Verb == `start` or `bootstrap` → YES
 *   - Anything else → NO
 *
 * This is a deliberately hardcoded whitelist rather than a VerbSpec
 * flag: the set of "creates or launches" verbs is small and stable, and
 * `needsProject` doesn't capture the distinction (bootstrap is
 * needsProject=false but exactly the thing we WANT blocked here).
 *
 * Pure — no FS access — so unit-testable without stubbing anything but
 * `env`.
 */
export function shouldCheckNoDridock(userArgs: readonly string[], env: Record<string, string | undefined>): boolean {
  if (cronModeRequested(env)) return true;
  const first = userArgs[0];
  if (first === undefined || first === "") return true;
  if (first.startsWith("-")) return true;
  return first === "start" || first === "bootstrap";
}

/**
 * Human-facing refusal message. The `verb` name lets the message name
 * which command is being blocked ("`start` refuses …") so the user
 * knows exactly what they invoked.
 */
export function formatNoDridockRefusal(markerPath: string, verb: string, binName: string): string[] {
  return [
    `❌ ${binName} ${verb}: dridock is disabled in this directory tree.\n`,
    `   Found: ${markerPath}\n`,
    `   Remove that file to re-enable dridock here (or 'cd' out of this tree first).\n`,
    `   The '${NO_DRIDOCK_MARKER}' marker also protects every subdirectory of the dir it lives in.\n`,
  ];
}

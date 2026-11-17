/**
 * The launch verbs run only from the project root (#123, 6.0.0).
 *
 * Before 6.0 a container's name and its workspace mount both came from the
 * cwd, so `dridock start` from `myproj/src` made a second, separate container
 * with `src/` as its workspace and its own session history: almost always an
 * accident. Containers are now named by the project's declared identity, so a
 * subdirectory would land in the SAME container as the root while asking to
 * mount a different path. Alan's call (2026-11-16): refuse, with no override.
 *
 * This subsumes the pre-6.0 `.dridock`-dir guard (a `.dridock` dir is a
 * subdirectory of the root) and its `DRIDOCK_ALLOW_SUBDIR` override, which is
 * gone. Setting it is reported, not silently ignored.
 *
 * Pure: takes cwd, env and the resolved root, returns a decision.
 */

export type WorkspaceGuardVerdict =
  | { kind: "ok"; notes: readonly string[] }
  | { kind: "not-root"; root: string; notes: readonly string[] };

/**
 * Settings that were removed, with why. Setting one is REPORTED on every launch
 * (never-silently-discard), and docs/environment-variables.md keeps a
 * `**Removed in X.Y.Z**` row for each. tests/test_env_var_readers.sh holds the
 * two together: every such row must be listed here and read nowhere else.
 */
export const REMOVED_ENV_KEYS: Readonly<Record<string, string>> = {
  DRIDOCK_ALLOW_SUBDIR: "removed in 6.0.0, #123: dridock runs only from the project root",
  DRIDOCK_NO_AUTO_MIGRATE: "removed in 6.0.0, #135: there is no auto-migration left to turn off",
};

export function guardWorkspace(
  cwd: string,
  env: Record<string, string | undefined>,
  projectRoot: string,
): WorkspaceGuardVerdict {
  const notes: string[] = [];
  for (const [key, why] of Object.entries(REMOVED_ENV_KEYS)) {
    const v = env[key];
    if (v !== undefined && v !== "") {
      notes.push(`!  ${key}=${v} no longer does anything (${why}).\n`);
    }
  }
  const norm = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  if (norm(cwd) !== norm(projectRoot)) return { kind: "not-root", root: norm(projectRoot), notes };
  return { kind: "ok", notes };
}

/** The refusal text, shared by every launch verb so they say the same thing. */
export function notRootMessage(cwd: string, root: string, binName: string, verb: string): string {
  return `❌ ${binName} ${verb} runs from the project root, not a subdirectory.\n`
    + `   You're in:        ${cwd}\n`
    + `   Project root is:  ${root}\n`
    + `     cd ${root} && ${binName} ${verb}\n`;
}

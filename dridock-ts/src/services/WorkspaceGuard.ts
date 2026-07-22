/**
 * Prevent the launch verbs from mounting `.dridock/` (or legacy
 * `.claudebox/`) as the workspace — a stray, almost-never-intended setup
 * that would spawn a separate container per dot-dir subdir. Ports
 * cb_guard_workspace at wrapper.sh:224. Pure — accepts cwd + env, returns
 * a decision, never prompts (the CLI wrapper decides how to surface it).
 */

export type WorkspaceGuardVerdict =
  | { kind: "ok" }
  | { kind: "in-dotdir"; dotName: ".dridock" | ".claudebox"; suggestedCd: string };

const OVERRIDE_ENV_KEYS = ["DRIDOCK_ALLOW_SUBDIR", "CLAUDEBOX_ALLOW_SUBDIR", "CLAUDE_ALLOW_SUBDIR"] as const;

export function guardWorkspace(cwd: string, env: Record<string, string | undefined>, projectRoot: string): WorkspaceGuardVerdict {
  // Explicit override — user knows what they're doing.
  for (const key of OVERRIDE_ENV_KEYS) {
    const v = env[key];
    if (v === "1" || v === "true" || v === "yes" || v === "on") return { kind: "ok" };
  }
  const inDridock = cwd === `${cwd.split("/.dridock")[0]}/.dridock`
    || cwd.startsWith(`${cwd.split("/.dridock")[0]}/.dridock/`);
  const inClaudebox = cwd === `${cwd.split("/.claudebox")[0]}/.claudebox`
    || cwd.startsWith(`${cwd.split("/.claudebox")[0]}/.claudebox/`);

  if (inDridock) {
    return {
      kind: "in-dotdir",
      dotName: ".dridock",
      suggestedCd: cwd.split("/.dridock")[0] || projectRoot,
    };
  }
  if (inClaudebox) {
    return {
      kind: "in-dotdir",
      dotName: ".claudebox",
      suggestedCd: cwd.split("/.claudebox")[0] || projectRoot,
    };
  }
  return { kind: "ok" };
}

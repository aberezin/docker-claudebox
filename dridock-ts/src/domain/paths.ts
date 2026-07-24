import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Path helpers — port of wrapper.sh's cb_config_home / cb_xdg_dir /
 * _cb_state_home / cb_consult_home / cb_fwbugs_home / cb_cdp_home /
 * cb_host_agent_home.
 *
 * Same three invariants as the bash originals (post-3.2.3 #29 fix):
 *   1. Prefer `~/.config/dridock/…` (3.0+ canonical).
 *   2. Fall back to `~/.config/claudebox/…` if only the legacy dir exists
 *      (one deprecation cycle; removed in 4.0).
 *   3. On the first call before either exists, return the dridock/ path as
 *      canonical — callers still need to `writeText`/`mkdir` before use.
 */

/** `~/.config` — respects `XDG_CONFIG_HOME` per XDG spec. */
export function configHome(env: Record<string, string | undefined>, home: string): string {
  return env["XDG_CONFIG_HOME"] ?? `${home}/.config`;
}

/**
 * The XDG root dridock uses — prefer `~/.config/dridock`, fall back to
 * `~/.config/claudebox` if that's the only one present. Ports cb_xdg_dir.
 */
export async function xdgRoot(fs: FileSystem, env: Record<string, string | undefined>, home: string): Promise<string> {
  const base = configHome(env, home);
  const newRoot = `${base}/dridock`;
  const oldRoot = `${base}/claudebox`;
  if (await fs.isDirectory(newRoot)) return newRoot;
  if (await fs.isDirectory(oldRoot)) return oldRoot;
  return newRoot; // canonical for fresh mkdir
}

/**
 * The XDG sub-tree for a specific state kind (consult, framework-bugs, cdp,
 * host-agent). Ports _cb_state_home from wrapper.sh (added in 3.2.4 for
 * #29). Uses PER-SUBDIR preference so a user who has ~/.config/dridock/
 * config.yml but not-yet-migrated legacy state dirs sees the legacy path
 * for those specific subdirs until `dridock migrate` moves them.
 */
export async function stateHome(
  fs: FileSystem,
  env: Record<string, string | undefined>,
  home: string,
  subname: "cdp" | "consult" | "framework-bugs" | "host-agent",
): Promise<string> {
  const base = configHome(env, home);
  const newPath = `${base}/dridock/${subname}`;
  const oldPath = `${base}/claudebox/${subname}`;
  if (await fs.isDirectory(newPath)) return newPath;
  if (await fs.isDirectory(oldPath)) return oldPath;
  return newPath;
}

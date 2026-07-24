/**
 * The per-workspace container-name convention. Ports the inline expression
 * `claude-$(printf '%s' "$PWD" | sed 's#/#_#g')` used throughout
 * wrapper.sh (e.g. lines 1192, 1420, and every start/stop path).
 *
 * Pure — no FS/env access. The `_prog` and `_cron` suffixes represent
 * different container roles sharing the same base name (`docker start`
 * can't inject new env, hence the sidecar-file IPC layer these names
 * anchor).
 */
export type ContainerRole = "interactive" | "programmatic" | "cron";

export function containerName(cwd: string, role: ContainerRole = "interactive"): string {
  const base = `claude-${cwd.replaceAll("/", "_")}`;
  switch (role) {
    case "interactive": return base;
    case "programmatic": return `${base}_prog`;
    case "cron": return `${base}_cron`;
  }
}

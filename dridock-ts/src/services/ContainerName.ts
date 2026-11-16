/**
 * Container names for a project's three roles.
 *
 * 6.0.0 (#123): names are keyed on the project's DECLARED identity —
 * `claude-<name>-<id>` — not on the directory it happens to live in. The
 * `id:` (gitignored config.yml) is per-clone and unique; the `name:` (tracked
 * project.yml) is a human label for `docker ps`. A directory rename therefore
 * changes nothing the harness owns. See docs/design/path-independence.md.
 *
 * Pure — no FS/env access. The `_prog` and `_cron` suffixes are different
 * container roles sharing one base name (`docker start` can't inject new env,
 * hence the sidecar-file IPC layer these names anchor).
 */
export type ContainerRole = "interactive" | "programmatic" | "cron";

export interface ProjectIdentity {
  /** The sanitized `name:` from project.yml, or undefined when none is declared. */
  readonly name?: string;
  /** The `id:` from config.yml. */
  readonly id: string;
}

export function containerName(ident: ProjectIdentity, role: ContainerRole = "interactive"): string {
  const base = ident.name !== undefined && ident.name !== ""
    ? `claude-${ident.name}-${ident.id}`
    : `claude-${ident.id}`;
  return withRole(base, role);
}

/**
 * The pre-6.0 name: `claude-` + the absolute cwd with `/` → `_`. Kept ONLY so
 * adoption can find a container created before 6.0.0 and replace it.
 *
 * LEGACY — removed in 7.0.0 (docs/roadmap.md, enforced by
 * tests/test_deprecation_deadlines.sh). Nothing but adoption may call it.
 */
export function legacyContainerName(cwd: string, role: ContainerRole = "interactive"): string {
  return withRole(`claude-${cwd.replaceAll("/", "_")}`, role);
}

export const ALL_ROLES: readonly ContainerRole[] = ["interactive", "programmatic", "cron"];

/** `base` plus the role suffix. Exported for callers holding a base name (a deferred adoption's). */
export function withRole(base: string, role: ContainerRole): string {
  switch (role) {
    case "interactive": return base;
    case "programmatic": return `${base}_prog`;
    case "cron": return `${base}_cron`;
  }
}

/**
 * Sanitize a project name for use in a container name (#123): lowercase, keep
 * `[a-z0-9-]` (anything else becomes `-`), collapse runs of `-`, trim `-` at
 * both ends. May return "" — the caller decides whether that's a refusal
 * (creating a project) or a fall-back to `claude-<id>` (adopting one).
 */
export function sanitizeProjectName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

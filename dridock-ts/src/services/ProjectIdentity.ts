import type { ProjectConfig } from "./ProjectConfig.ts";
import { sanitizeProjectName, type ProjectIdentity } from "./ContainerName.ts";

/**
 * Resolve a project's identity for container naming (#123): `id:` from the
 * gitignored config.yml, `name:` from the tracked project.yml.
 *
 * A project that predates 6.0 has no `name:`. On the launch paths (`mode:
 * "adopt"`) it is inferred ONCE from the root's basename, written to
 * project.yml, and announced, so it's visible and editable rather than a
 * silent default; after that a directory rename can't change it. Read-only
 * callers (stop, info) compute the same inference without writing.
 *
 * A declared name that sanitizes to something different is used sanitized and
 * named on stderr; one that sanitizes to nothing falls back to `claude-<id>`.
 */
export async function resolveIdentity(
  cfg: ProjectConfig,
  project: { readonly root: string; readonly projectPath: string; readonly dotName: string },
  id: string,
  mode: "adopt" | "read-only",
  warn: (m: string) => void,
): Promise<ProjectIdentity> {
  const declared = await cfg.projectName(project.projectPath);
  if (declared.raw !== undefined) {
    const s = declared.sanitized ?? "";
    if (s === "") {
      warn(`!  name: '${declared.raw}' in ${project.dotName}/project.yml has no usable characters [a-z0-9-]; containers are named claude-${id}.\n`);
      return { id };
    }
    if (s !== declared.raw) {
      warn(`!  name: '${declared.raw}' in ${project.dotName}/project.yml is used as '${s}' (container names allow [a-z0-9-]).\n`);
    }
    return { name: s, id };
  }

  const base = project.root.replace(/\/+$/, "").split("/").pop() ?? "";
  const inferred = sanitizeProjectName(base);
  if (inferred === "") {
    if (mode === "adopt") {
      warn(`!  no name: in ${project.dotName}/project.yml, and '${base}' has no usable characters; containers are named claude-${id}.\n`
        + `   Add a line like  name: my-project  to ${project.dotName}/project.yml to label them.\n`);
    }
    return { id };
  }
  if (mode === "adopt") {
    await cfg.setProjectName(project.projectPath, inferred);
    warn(`📝 wrote  name: ${inferred}  to ${project.dotName}/project.yml (6.0 names containers by project, #123).\n`
      + `   It's tracked: commit it. Edit it now if you want a different label; later renames won't change it.\n`);
  }
  return { name: inferred, id };
}

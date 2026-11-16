import type { Docker, ContainerSummary } from "../infra/Docker.ts";
import type { FileSystem } from "../infra/FileSystem.ts";
import { ALL_ROLES, containerName, type ContainerRole, type ProjectIdentity } from "./ContainerName.ts";

/**
 * Adopt containers created before 6.0.0, and catch a project that moved or was
 * copied (#123, docs/design/path-independence.md § Nobody gets stranded).
 *
 * Every container in a project's VM belongs to that project's `id:` (the VM is
 * `cb-<id>`), so the containers to consider are the ones in this VM:
 *
 *   - LEGACY containers, named `claude-_<path>` (the pre-6.0 cwd form). Each is
 *     adopted by RECREATE, not `docker rename`: the entrypoint finds its
 *     sidecars through `DRIDOCK_CONTAINER_NAME`, fixed at `docker run`, so a
 *     renamed container would look for sidecars under its old name on the next
 *     start and load no secrets, silently. Adopting = remove the stopped
 *     container; the normal start path then creates it under the new name.
 *   - OLD-LABEL containers, `claude-<other-name>-<id>`: this project's
 *     containers from before someone edited `name:` in project.yml. Same
 *     treatment as legacy, or the edit would orphan them.
 *   - CURRENT-scheme containers whose workspace mount isn't this root: the
 *     project moved (old path gone: recreate) or was copied (old path still
 *     there: two directories share one `id:`, refuse).
 *
 * Rules, each a lesson already paid for here:
 *   1. Never remove a RUNNING container. If one needs adopting, the whole
 *      adoption is deferred and this run keeps using the legacy names (rc 0,
 *      loud). It happens on the next start after `dridock down`.
 *   2. A collision is a hard error naming both containers.
 *   3. A copy is a hard error naming both paths and the fix.
 *   4. Nothing is run inside a container.
 *   5. Once no legacy container is left, legacy sidecars in the data dir are
 *      removed and counted: `-secrets` / `-auth` hold credential values, and
 *      leaving them under a name nothing will read again is the #121 problem.
 */
export type AdoptionOutcome =
  | { readonly kind: "ok"; readonly notes: readonly string[] }
  | { readonly kind: "deferred"; readonly legacyBase: string; readonly notes: readonly string[] }
  | { readonly kind: "refused"; readonly message: string };

export interface AdoptionInput {
  readonly context: string;
  /** Absolute project root (this run's workspace). */
  readonly root: string;
  readonly ident: ProjectIdentity;
  /** Per-project data dir holding the sidecars. */
  readonly dataDir: string;
  readonly binName: string;
}

const LEGACY_PREFIX = "claude-_";
/** `.<container-name>-<kind>`, the SidecarWriter layout. */
const SIDECAR_FILE = /^\.(claude-.+?)-(auth|secrets|env|cdp|hostagent|vmip|args|interactive-args|update|no-continue)$/;
/** `dridock auth|mcp` throwaways (`<name>_<verb>_<ms>`, run with --rm). Never project containers. */
const THROWAWAY = /_(?:auth|mcp)_\d+$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class AdoptionService {
  constructor(private readonly docker: Docker, private readonly fs: FileSystem) {}

  async adopt(inp: AdoptionInput): Promise<AdoptionOutcome> {
    const all = await this.docker.listContainers(inp.context, "claude-");
    const notes: string[] = [];
    const current = new Map<ContainerRole, string>(ALL_ROLES.map((r) => [r, containerName(inp.ident, r)]));
    const currentNames = new Set(current.values());
    const toRemove: ContainerSummary[] = [];
    const runningBlockers: ContainerSummary[] = [];

    // ── current-scheme containers: moved or copied? ─────────────────────
    for (const c of all.filter((x) => currentNames.has(x.name))) {
      const src = c.workspaceSource;
      if (src === undefined || src === inp.root) continue;
      if (await this.fs.isDirectory(src)) return { kind: "refused", message: copyMessage(c.name, src, inp) };
      if (c.state === "running") {
        return {
          kind: "refused",
          message: `❌ container ${c.name} is running with its workspace at ${src}, which no longer exists\n`
            + `   (the project moved to ${inp.root}). Stop it, then start again so it is recreated here:\n`
            + `     ${inp.binName} down && ${inp.binName} start\n`,
        };
      }
      notes.push(`🔄 project moved from ${src}: recreating ${c.name} at ${inp.root}\n`);
      toRemove.push(c);
    }

    // ── legacy and old-label containers ─────────────────────────────────
    const oldLabel = new RegExp(`^claude-(?:[a-z0-9-]+-)?${escapeRe(inp.ident.id)}(?:_prog|_cron)?$`);
    const isOld = (n: string): boolean => !currentNames.has(n) && !THROWAWAY.test(n)
      && (n.startsWith(LEGACY_PREFIX) || oldLabel.test(n));
    let legacyBase: string | undefined;
    for (const c of all.filter((x) => isOld(x.name))) {
      const role = roleOf(c.name);
      const src = c.workspaceSource;
      // A pre-6.0 container for a SUBDIRECTORY of this project (6.0 starts only
      // from the root). Not a copy; its history lives under its own slug. Named,
      // left alone.
      if (src !== undefined && src !== inp.root && src.startsWith(`${inp.root}/`)) {
        notes.push(`!  pre-6.0 container ${c.name} was started from a subdirectory (${src}).\n`
          + `   6.0 starts only from the project root, so nothing will use it again. Remove it with:\n`
          + `     docker --context ${inp.context} rm ${c.name}\n`);
        continue;
      }
      if (src !== undefined && src !== inp.root && await this.fs.isDirectory(src)) {
        return { kind: "refused", message: copyMessage(c.name, src, inp) };
      }
      const target = current.get(role)!;
      if (all.some((x) => x.name === target)) {
        return {
          kind: "refused",
          message: `❌ can't adopt ${c.name}: ${target} already exists.\n`
            + `   Both are this project's ${role} container, under the pre-6.0 and the 6.0 name.\n`
            + `   Keep one. To keep the new one, remove the old:\n`
            + `     docker --context ${inp.context} rm ${c.name}\n`,
        };
      }
      if (c.state === "running" && src !== undefined && src !== inp.root) {
        // Live, and working on a directory that's gone (the project moved
        // under it). Attaching would put the user in the old, missing path.
        return {
          kind: "refused",
          message: `❌ ${c.name} is running with its workspace at ${src}, which no longer exists\n`
            + `   (the project moved to ${inp.root}). Stop it, then start again so it is recreated here:\n`
            + `     ${inp.binName} down && ${inp.binName} start\n`,
        };
      }
      if (c.state === "running") {
        runningBlockers.push(c);
        if (role === "interactive") legacyBase = c.name;
        continue;
      }
      toRemove.push(c);
      notes.push(`🔄 adopting ${c.name} → ${target} (${c.name.startsWith(LEGACY_PREFIX) ? "pre-6.0 name" : "name: changed"}; recreated, session history kept)\n`);
    }

    if (runningBlockers.length > 0) {
      // Rule 1: touch nothing. Use the legacy names for this run.
      const base = legacyBase ?? stripRole(runningBlockers[0]!.name);
      return {
        kind: "deferred",
        legacyBase: base,
        notes: [
          `!  ${runningBlockers.map((c) => c.name).join(", ")} ${runningBlockers.length === 1 ? "is" : "are"} running under the pre-6.0 name.\n`
          + `   Not touching a live container. It is adopted (renamed to ${containerName(inp.ident)}) on the\n`
          + `   next start after:  ${inp.binName} down\n`,
        ],
      };
    }

    for (const c of toRemove) await this.docker.containerRemove(inp.context, c.name);

    // Rule 5: with no legacy container left, legacy sidecars are dead weight
    // (and some hold credentials).
    const stale = (await this.listOrEmpty(inp.dataDir)).filter((f) => {
      const m = SIDECAR_FILE.exec(f);
      return m !== null && isOld(m[1]!);
    });
    for (const f of stale) await this.fs.removeFile(`${inp.dataDir}/${f}`);
    if (stale.length > 0) {
      const creds = stale.filter((f) => f.endsWith("-secrets") || f.endsWith("-auth")).length;
      notes.push(`🧹 removed ${stale.length} stale sidecar file(s) from ${inp.dataDir}`
        + (creds > 0 ? `, ${creds} of them holding credentials (-secrets/-auth)` : "") + "\n");
    }
    return { kind: "ok", notes };
  }

  private async listOrEmpty(dir: string): Promise<string[]> {
    try { return await this.fs.listDir(dir); } catch { return []; }
  }
}

function roleOf(name: string): ContainerRole {
  if (name.endsWith("_prog")) return "programmatic";
  if (name.endsWith("_cron")) return "cron";
  return "interactive";
}

function stripRole(name: string): string {
  return name.replace(/_(prog|cron)$/, "");
}

function copyMessage(name: string, otherPath: string, inp: AdoptionInput): string {
  return `❌ this project's id (${inp.ident.id}) is also used by ${otherPath}.\n`
    + `   ${name} works on that directory, and it still exists, so this looks like a COPY\n`
    + `   (cp -r), not a move. Two directories can't share one id: they'd share a container.\n`
    + `   Give this copy its own id: in ${inp.root}/.dridock/config.yml, change\n`
    + `     id: ${inp.ident.id}\n`
    + `   to a new 8-hex-digit value (\`openssl rand -hex 4\` makes one), then start again.\n`
    + `   Or, if ${otherPath} is the stale one, delete it and start again.\n`;
}

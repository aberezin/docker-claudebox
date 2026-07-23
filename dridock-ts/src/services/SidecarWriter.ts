import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Every container role for which the wrapper writes sidecars —
 * matches wrapper.sh's `for _crole in "" _prog _cron` loop pattern
 * (e.g. auth: wrapper.sh:2965-2970).
 *
 * The suffix goes AFTER the base container name:
 *   interactive: `${cname}${suffix}-<kind>`   (empty suffix)
 *   programmatic: `${cname}_prog-<kind>`
 *   cron:         `${cname}_cron-<kind>`
 */
export const CONTAINER_ROLES = ["", "_prog", "_cron"] as const;
export type ContainerRoleSuffix = typeof CONTAINER_ROLES[number];

/**
 * One writer for every kind of sidecar the entrypoint reads. Ports the
 * wrapper.sh's per-role file-write pattern (wrapper.sh:2946-2951 env,
 * :2865 hostagent, :2838 cdp, :2965-2970 auth). Every sidecar:
 *   - lives INSIDE the per-project data dir (dataDir mount source)
 *   - is chmod 600 for auth/secrets/env; chmod 644 for cdp/hostagent/vmip
 *   - is written EVERY run (so stale content from a prior run never
 *     survives — matches wrapper.sh's per-role for-loop pattern)
 *
 * The entrypoint's `docker start` path re-reads these sidecars on
 * every start (env can't be injected past the first `docker run`),
 * which is why they're durable-on-disk rather than -e-only.
 */
export class SidecarWriter {
  constructor(private readonly fs: FileSystem, private readonly dataDir: string, private readonly baseContainerName: string) {}

  /**
   * Write the same content to all three role variants of one sidecar
   * kind. Idempotent — a subsequent run overwrites. Empty `content`
   * yields empty files (deliberate: bash writes empty for kinds like
   * cdp/hostagent to signal "off" without deleting the sidecar).
   */
  async writeAllRoles(kind: SidecarKind, content: string): Promise<readonly string[]> {
    const written: string[] = [];
    for (const suffix of CONTAINER_ROLES) {
      const path = this.pathFor(kind, suffix);
      await this.fs.writeText(path, content, { mode: MODE_FOR_KIND[kind] });
      written.push(path);
    }
    return written;
  }

  /**
   * Write to one specific role. Used by the args-sidecars (`-args`,
   * `-interactive-args`) that ARE role-specific.
   */
  async writeOneRole(kind: SidecarKind, role: ContainerRoleSuffix, content: string): Promise<string> {
    const path = this.pathFor(kind, role);
    await this.fs.writeText(path, content, { mode: MODE_FOR_KIND[kind] });
    return path;
  }

  /** Absolute path of a sidecar file. Exposed so tests can assert on it. */
  pathFor(kind: SidecarKind, role: ContainerRoleSuffix): string {
    return `${this.dataDir}/.${this.baseContainerName}${role}-${kind}`;
  }
}

/**
 * Every sidecar kind the wrapper writes. Kept as a closed union so a new
 * kind added here is a compile-time signal to update MODE_FOR_KIND.
 */
export type SidecarKind =
  | "auth"          // ANTHROPIC_API_KEY + CLAUDE_CODE_OAUTH_TOKEN — chmod 600
  | "secrets"       // .dridock/secrets.env copy                   — chmod 600
  | "env"           // DRIDOCK_ENV_* passthrough                   — chmod 600
  | "cdp"           // DRIDOCK_HOST_CDP_URL                        — chmod 644
  | "hostagent"     // DRIDOCK_HOST_AGENT_URL + TOKEN              — chmod 600 (has TOKEN)
  | "vmip"          // DRIDOCK_VM_IP + DRIDOCK_HOSTNAME            — chmod 644
  | "args"          // programmatic-mode PASS_ARGS                 — chmod 600
  | "interactive-args"  // interactive-mode extras                 — chmod 600
  | "update"        // presence marker → entrypoint runs `claude --update` — chmod 644
  | "no-continue";  // presence marker → entrypoint skips --continue     — chmod 644

/**
 * Permission bits per kind. Auth/secrets/env/hostagent hold secrets →
 * 0o600. CDP URL / VM-IP / hostname / markers are non-secret → 0o644.
 * Bash's chmod calls at each writer.
 */
const MODE_FOR_KIND: Record<SidecarKind, number> = {
  auth: 0o600,
  secrets: 0o600,
  env: 0o600,
  hostagent: 0o600,
  cdp: 0o644,
  vmip: 0o644,
  args: 0o600,
  "interactive-args": 0o600,
  update: 0o644,
  "no-continue": 0o644,
};

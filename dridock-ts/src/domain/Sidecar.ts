/**
 * Sidecar naming — the file-based IPC between the host wrapper and the
 * container's entrypoint. Both sides MUST produce/consume the exact same
 * filenames for the same container role, or the entrypoint reads nothing
 * and every non-interactive mode breaks silently.
 *
 * In the bash wrapper this convention lived in prose comments + scattered
 * literals across `wrapper.sh` and `entrypoint.sh`. When a fifth sidecar
 * (`-env`, #30) was added, both sides had to be edited in lockstep and one
 * out-of-sync letter would have been invisible until a runtime failure.
 *
 * Here: single source of truth. TS callers use these helpers; entrypoint.sh
 * reads the emitted `sidecar-names.json` (see `bin/emit-sidecar-manifest.ts`)
 * so both sides literally can't drift.
 */

/**
 * Container roles the wrapper spins up per project. Interactive is the base
 * (no suffix); `_prog` is the -p programmatic-mode container; `_cron` is the
 * cron/telegram daemon. Same three-role split wrapper.sh has today.
 */
export type ContainerRole = "" | "_prog" | "_cron";

/**
 * Every sidecar kind the entrypoint knows how to read + what wrapper.sh
 * writes it for. Adding a new kind is one entry here — the emit script
 * updates the JSON manifest and entrypoint.sh picks it up on its next boot.
 * See docs/design/env-var-rename.md for the sidecar-load-order rule.
 */
export const SIDECAR_KINDS = {
  auth: {
    filename: "auth",
    mode: 0o600 as const,
    description: "OAuth token + API key — chmod 600, never on argv",
  },
  secrets: {
    filename: "secrets",
    mode: 0o600 as const,
    description: "Per-project .dridock/secrets.env — chmod 600",
  },
  env: {
    filename: "env",
    mode: 0o600 as const,
    description: "DRIDOCK_ENV_* forwards — chmod 600, may carry credentials (#30)",
  },
  cdp: {
    filename: "cdp",
    mode: 0o644 as const,
    description: "Browser-bridge CDP URL — non-sensitive, plain 644",
  },
  vmip: {
    filename: "vmip",
    mode: 0o644 as const,
    description: "Per-project VM IP (rotating; refreshed each run)",
  },
  hostagent: {
    filename: "hostagent",
    mode: 0o644 as const,
    description: "Host-agent bridge URL (framework-dev only; opt-in)",
  },
} as const;

export type SidecarKind = keyof typeof SIDECAR_KINDS;

/**
 * The one function both sides need to agree on. Given a container name and
 * role, and the sidecar kind, produces the path.
 *
 * Layout: `<claudeDir>/.<containerName><role>-<kind>` — matches wrapper.sh's
 * existing format so a mid-migration user can have wrapper.sh-emitted
 * sidecars read by the TS wrapper (and vice-versa).
 */
export function sidecarFilename(containerName: string, role: ContainerRole, kind: SidecarKind): string {
  return `.${containerName}${role}-${SIDECAR_KINDS[kind].filename}`;
}

/**
 * All three roles for a given base container name + kind. Wrapper writes to
 * every role each run so a subsequent `_prog` or `_cron` invocation sees the
 * up-to-date value even though `docker start` can't accept new env.
 */
export function sidecarFilenamesForAllRoles(containerName: string, kind: SidecarKind): Record<ContainerRole, string> {
  return {
    "": sidecarFilename(containerName, "", kind),
    "_prog": sidecarFilename(containerName, "_prog", kind),
    "_cron": sidecarFilename(containerName, "_cron", kind),
  };
}

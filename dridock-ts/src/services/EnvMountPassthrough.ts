import type { RunArgs } from "../infra/ContainerRuntime.ts";

/**
 * Two related host→container env-var passthroughs — same shape, both
 * matched by prefix and stripped:
 *   - DRIDOCK_ENV_FOO=bar / CLAUDEBOX_ENV_FOO=bar / CLAUDE_ENV_FOO=bar
 *     → `-e FOO=bar` inside the container + `-env` sidecar row
 *   - DRIDOCK_MOUNT_X=/host / CLAUDEBOX_MOUNT_X=/host / CLAUDE_MOUNT_X=/host:/ctr
 *     → `-v /host:/host` (auto-mirrored) or `-v /host:/ctr` (colon form)
 *
 * Ports wrapper.sh:2932-2960. Pure over the process env — no FS/docker
 * calls; returns the shape to merge into RunArgs.env / RunArgs.mounts +
 * the sidecar content to write.
 */

const ENV_PREFIXES = ["DRIDOCK_ENV_", "CLAUDEBOX_ENV_", "CLAUDE_ENV_"] as const;
const MOUNT_PREFIXES = ["DRIDOCK_MOUNT_", "CLAUDEBOX_MOUNT_", "CLAUDE_MOUNT_"] as const;

export interface EnvPassthroughResult {
  /** New env pairs to append to RunArgs.env. */
  readonly envAdditions: readonly RunArgs["env"][number][];
  /** Content of the `.<name>-env` sidecar — always defined (empty string
   *  when no forwards, matching bash's "always-write-so-stale-doesn't-linger"
   *  invariant at wrapper.sh:2946-2951). */
  readonly sidecarContent: string;
}

export function collectEnvPassthrough(env: Record<string, string | undefined>): EnvPassthroughResult {
  const additions: RunArgs["env"][number][] = [];
  const lines: string[] = [];
  // Iterate in a stable order so tests + docker inspect look the same across runs.
  for (const key of Object.keys(env).sort()) {
    for (const prefix of ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        const stripped = key.slice(prefix.length);
        if (stripped === "") break;   // `DRIDOCK_ENV_=` (no name) — skip
        const value = env[key] ?? "";
        additions.push({ key: stripped, value });
        lines.push(`${stripped}=${value}`);
        break;                        // stop after first-prefix match
      }
    }
  }
  return {
    envAdditions: additions,
    // Trailing newline matches bash's `printf '%s\n' … | tee sidecar` when
    // there's content; empty string is empty file. Bash's `_ENV_LINES+=…$'\n'`
    // accumulates a trailing newline per pair.
    sidecarContent: lines.length > 0 ? lines.join("\n") + "\n" : "",
  };
}

export interface MountPassthroughResult {
  /** New mount specs to append to RunArgs.mounts. */
  readonly mountAdditions: readonly RunArgs["mounts"][number][];
}

export function collectMountPassthrough(env: Record<string, string | undefined>): MountPassthroughResult {
  const additions: RunArgs["mounts"][number][] = [];
  for (const key of Object.keys(env).sort()) {
    for (const prefix of MOUNT_PREFIXES) {
      if (key.startsWith(prefix)) {
        const value = env[key] ?? "";
        if (value === "") break;      // empty value — skip (bash does too via the read loop)
        // Bash: `case "$value" in *:*) -v $value ;; *) -v $value:$value ;; esac`
        if (value.includes(":")) {
          const [host, container] = value.split(":", 2) as [string, string];
          additions.push({ host, container });
        } else {
          additions.push({ host: value, container: value });
        }
        break;
      }
    }
  }
  return { mountAdditions: additions };
}

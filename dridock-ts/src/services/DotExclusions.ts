/**
 * Paths under `$HOME` that must NOT persist into the per-project dot dir
 * (#80 phase 2).
 *
 * ## Why exclude at all
 *
 * Phase 2 mounts the per-project dot dir over `/home/claude` so agent-written
 * dotfiles survive a container recreate. That makes **persist** the default,
 * which is the right default — a forgotten exclusion then wastes disk visibly
 * instead of losing state silently. But two kinds of directory should not go
 * to the host:
 *
 *   1. **Performance.** Bind mounts under macOS virtualisation are slow for
 *      many small files. `~/.npm` and `~/.cache` are exactly that shape, so
 *      leaving them on the bind would push every npm install and every cache
 *      write through the VM↔host boundary. Excluding them is a speed fix, not
 *      just a tidiness one.
 *   2. **Size.** They are regeneratable and can reach gigabytes. The dot dir
 *      lives in the user's XDG config tree; a multi-GB module cache does not
 *      belong there.
 *
 * ## Why NAMED volumes rather than tmpfs or anonymous volumes
 *
 * - **tmpfs** is RAM-backed, and `~/.npm` can be GB-scale — a big install
 *   would pressure a VM sized for the workload, not for its caches. It also
 *   dies on container STOP, so an ordinary `dridock down && dridock start`
 *   would throw the cache away. That is worse than today, where these survive
 *   a restart and are lost only on recreate.
 * - **Anonymous volumes** would leak: `containerRemove` runs `docker rm -f`
 *   without `-v`, so every recreate would strand another one. Trading VM
 *   orphans for volume orphans is not progress.
 * - **Named volumes** are VM-local (fast), survive a recreate (which is what
 *   you want from a cache), and are addressable.
 *
 * ## Lifetime — why there is no reaper
 *
 * These volumes live inside the PER-PROJECT VM's docker daemon, and
 * `dridock destroy` runs `colima delete` on that whole VM. The volumes go with
 * it. In a shared-daemon setup named volumes would need explicit cleanup; the
 * per-project-VM model makes that unnecessary, which is the reason named
 * volumes are safe here and anonymous ones still are not (those leak on every
 * recreate, long before any destroy).
 *
 * The one residual case: editing `DOT_EXCLUDED_PATHS` changes the derived
 * names, so the previous set is orphaned inside a still-living VM. Bounded (a
 * handful per project, only on a config change) and visible via
 * `docker volume ls`. Prune with `docker volume prune` in that VM if it ever
 * matters.
 */
export const DOT_EXCLUDED_PATHS = [
  ".cache",
  ".npm",
  ".local/share/pnpm/store",
  "go/pkg/mod",
] as const;

/** Volume name prefix for one project. Also the reap pattern for `destroy`. */
export function dotVolumePrefix(projectId: string): string {
  return `dridock-${projectId}-`;
}

/**
 * The `-v <name>:<container>` pairs shadowing each excluded path.
 *
 * Names are derived from the path, so adding an entry above is the only edit
 * needed — there is no second list to keep in sync, which is how the two would
 * eventually disagree.
 */
export function dotExclusionVolumes(
  projectId: string,
  home = "/home/claude",
): readonly { readonly name: string; readonly container: string }[] {
  const prefix = dotVolumePrefix(projectId);
  return DOT_EXCLUDED_PATHS.map((p) => ({
    // Docker volume names allow [a-zA-Z0-9][a-zA-Z0-9_.-] only, so flatten the
    // path separators rather than letting an invalid name reach the daemon.
    name: `${prefix}${p.replace(/^\./, "").replace(/[/.]/g, "-")}`,
    container: `${home}/${p}`,
  }));
}

import type { Docker } from "../infra/Docker.ts";

/**
 * Recreate the container if it was created from a now-stale image (e.g.
 * after `dridock harness sync` reseeded a newer image). Ports
 * cb_refresh_container at wrapper.sh:723.
 *
 * A plain `docker start` on a stale container keeps running the OLD image;
 * this compares the container's `.Image` (the sha the container was
 * created from) to the current tag's `.Id`. If they differ, force-remove
 * the container so the run path recreates it. Session state survives (host
 * ~/.claude mount); container-fs scratch (runtime `apt install`) does not.
 *
 * No-op cases: container absent, image absent, or ids match.
 */
export class ContainerRefresher {
  constructor(private readonly docker: Docker) {}

  /**
   * Returns true iff we removed the container (caller should re-check
   * containerIdentity if it cares — a downstream `psFilter` will simply
   * not find it and the run path will recreate).
   */
  async maybeRefresh(context: string, containerName: string, image: string): Promise<boolean> {
    const container = await this.docker.containerIdentity(context, containerName);
    if (container === undefined) return false;  // no container to refresh
    const identity = await this.docker.imageIdentity(context, image);
    if (identity === undefined) return false;   // image absent — nothing to compare against
    if (container.imageId === identity.id) return false; // same image, nothing to do
    await this.docker.containerRemove(context, containerName);
    return true;
  }
}

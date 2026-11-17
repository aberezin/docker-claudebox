import type { Docker } from "../infra/Docker.ts";

/** What `maybeRefresh` did. */
export type RefreshOutcome =
  | { readonly kind: "current" }                          // absent, no image to compare, or same image
  | { readonly kind: "recreated" }                        // stale and stopped: removed, the run path recreates it
  | { readonly kind: "running"; readonly from: string; readonly to: string }   // stale but LIVE: left alone (#126)
  | { readonly kind: "remove-failed"; readonly rc: number; readonly from: string; readonly to: string };

/**
 * Recreate the container if it was created from a now-stale image (e.g.
 * after `./install.sh` or a #118 reseed). Ports cb_refresh_container at
 * wrapper.sh:723.
 *
 * A plain `docker start` on a stale container keeps running the OLD image;
 * this compares the container's `.Image` (the sha the container was
 * created from) to the current tag's `.Id`. If they differ, remove the
 * container so the run path recreates it. Session state survives (host
 * ~/.claude mount); container-fs scratch (runtime `apt install`) does not.
 *
 * #126: never a RUNNING container. Through 5.x this was `docker rm -f`, so
 * a claudebot working in another terminal died mid-turn whenever the image
 * had moved, which since #118 is routine. Now a running one is reported
 * (`running`) and left alone, and the removal itself is a non-force
 * `docker rm`, so a container that starts between the check and the rm is
 * refused by the daemon (`remove-failed`) rather than killed. Same rule as
 * #123's adoption: never recreate a running container.
 */
export class ContainerRefresher {
  constructor(private readonly docker: Docker) {}

  async maybeRefresh(context: string, containerName: string, image: string): Promise<RefreshOutcome> {
    const container = await this.docker.containerIdentity(context, containerName);
    if (container === undefined) return { kind: "current" };
    const identity = await this.docker.imageIdentity(context, image);
    if (identity === undefined) return { kind: "current" };
    if (container.imageId === identity.id) return { kind: "current" };
    const from = container.imageId, to = identity.id;
    if (container.status === "running") return { kind: "running", from, to };
    const rc = await this.docker.containerRemoveStopped(context, containerName);
    return rc === 0 ? { kind: "recreated" } : { kind: "remove-failed", rc, from, to };
  }
}

/** Short image id for messages: `sha256:abcdef123456…` → `abcdef123456`. */
export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

/** The #126 refusal, for a stale container that is running (or started meanwhile). */
export function staleRunningMessage(name: string, o: { from: string; to: string; rc?: number }, binName: string): string {
  const why = o.rc === undefined
    ? `is running`
    : `couldn't be removed (docker rm rc ${o.rc}; it may have started since this run looked)`;
  return `❌ ${name} ${why} on an older image (${shortId(o.from)}; the project image is now ${shortId(o.to)}).\n`
    + `   Not stopping a live session to update it, so nothing was started.\n`
    + `   To switch to the new image, end that session, then:\n`
    + `     ${binName} down && ${binName} start\n`;
}

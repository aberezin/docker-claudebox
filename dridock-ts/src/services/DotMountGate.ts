import type { Docker } from "../infra/Docker.ts";
import { Version } from "../domain/Version.ts";

/**
 * Decide whether it is SAFE to bind-mount the per-project dot dir over
 * `/home/claude` (#80 phase 2).
 *
 * The dangerous upgrade direction is **new host + OLD image**, not the reverse.
 * Before 5.0.1 the image baked the Claude CLI, the entrypoint and the daemons
 * into `$HOME`; mounting over that shadows all of them and produces a container
 * that cannot start. Old host + new image is harmless — no mount, dotfiles stay
 * ephemeral, i.e. pre-phase-2 behaviour.
 *
 * So the gate is on the IMAGE, never on the host's own version: the host is by
 * definition new if this code is running.
 */
export const DOT_MOUNT_MIN_IMAGE_VERSION = "5.0.1";

export type DotMountDecision =
  | { readonly kind: "mount" }
  | { readonly kind: "skip"; readonly reason: string; readonly note: string };

export class DotMountGate {
  constructor(private readonly docker: Docker, private readonly image: string) {}

  async decide(context: string): Promise<DotMountDecision> {
    const raw = await this.docker.imageVersion(context, this.image);

    // "unavailable" (no image yet) or "unstamped" (predates the version label)
    // are both "cannot prove it is safe". Refuse — a wrong guess here is a
    // container that will not boot, not a degraded one.
    if (raw === "unavailable" || raw === "unstamped") {
      return {
        kind: "skip",
        reason: `image version is '${raw}'`,
        note: "dotfiles will NOT persist across recreate; rebuild the image (make build) to enable it",
      };
    }

    // parseLoose does NOT throw on garbage — it yields 0.0.0, which would
    // compare as "older" and report a misleading "predates 5.0.1" for a label
    // that is not a version at all. Check the shape first so the two cases get
    // honest, distinguishable messages. (0.0.0 itself IS a real case: the
    // Dockerfile's ARG default when a build forgets to pass DRIDOCK_VERSION.)
    if (!/^\d+\.\d+\.\d+/.test(raw)) {
      return {
        kind: "skip",
        reason: `image version '${raw}' is unparseable`,
        note: "dotfiles will NOT persist across recreate; rebuild the image (make build)",
      };
    }

    try {
      const min = Version.parseLoose(DOT_MOUNT_MIN_IMAGE_VERSION);
      if (Version.parseLoose(raw).compareTo(min) === "lt") {
        return {
          kind: "skip",
          reason: `image ${raw} predates ${DOT_MOUNT_MIN_IMAGE_VERSION}`,
          note:
            "that image bakes the claude CLI into $HOME, so mounting over it would " +
            "shadow the CLI and the container would not start; rebuild with 'make build'",
        };
      }
    } catch {
      return {
        kind: "skip",
        reason: `image version '${raw}' is unparseable`,
        note: "dotfiles will NOT persist across recreate",
      };
    }
    return { kind: "mount" };
  }
}

import type { Docker } from "../infra/Docker.ts";
import type { Colima } from "../infra/Colima.ts";
import { infraContext, INFRA_PROFILE } from "../infra/Docker.ts";
import { Version } from "../domain/Version.ts";

/**
 * Seed the claudebot image into a target docker context, or reseed if
 * it's drifted below cb-infra's version. Ports cb_ensure_image at
 * wrapper.sh:696.
 *
 * Semantics:
 *   - Target has image present:
 *       - cb-infra is Running AND holds a newer version → save|load
 *         (auto-reseed after `make build`).
 *       - Otherwise → no-op (return already-present).
 *   - Target lacks the image:
 *       - Require cb-infra running + image present, then save|load
 *         (first-time seed).
 *
 * The "cb-infra must exist + hold the image" precondition is delegated
 * back to the caller via `requireSource` — VmEnsureService already runs
 * the same check on absent-VM path so we don't duplicate.
 */
export interface ImageEnsureDeps {
  readonly docker: Docker;
  readonly colima: Colima;
  readonly image: string;
}

export type ImageEnsureOutcome =
  | { readonly kind: "already-current"; readonly version: string }
  | { readonly kind: "reseeded"; readonly from: string; readonly to: string }
  | { readonly kind: "first-seed"; readonly version: string }
  | { readonly kind: "failed"; readonly reason: string };

export class ImageEnsureService {
  constructor(private readonly deps: ImageEnsureDeps) {}

  async ensure(targetContext: string): Promise<ImageEnsureOutcome> {
    const targetVersion = await this.deps.docker.imageVersion(targetContext, this.deps.image);
    const targetPresent = targetVersion !== "unavailable";

    if (targetPresent) {
      // Drift-detect: only if cb-infra is running (never boot it just to check).
      const infraRunning = await this.deps.colima.isRunning(INFRA_PROFILE);
      if (!infraRunning) return { kind: "already-current", version: targetVersion };

      const infraVersion = await this.deps.docker.imageVersion(infraContext(), this.deps.image);
      if (infraVersion === "unavailable" || infraVersion === "unstamped") {
        return { kind: "already-current", version: targetVersion };
      }
      if (targetVersion === "unstamped" || this.isNewer(infraVersion, targetVersion)) {
        const rc = await this.deps.docker.saveAndLoad(infraContext(), this.deps.image, targetContext);
        if (rc !== 0) return { kind: "failed", reason: `save|load rc ${rc}` };
        return { kind: "reseeded", from: targetVersion, to: infraVersion };
      }
      return { kind: "already-current", version: targetVersion };
    }

    // First-time seed. Caller (VmEnsureService) already gated on cb-infra
    // presence + image-in-cb-infra for the absent-VM path; if we're here
    // via the "VM was stopped but empty" branch we do the same gate.
    if (!(await this.deps.colima.isRunning(INFRA_PROFILE))) {
      return { kind: "failed", reason: `${INFRA_PROFILE} not running — cannot seed image` };
    }
    const infraVersion = await this.deps.docker.imageVersion(infraContext(), this.deps.image);
    if (infraVersion === "unavailable") {
      return { kind: "failed", reason: `${this.deps.image} not present in ${INFRA_PROFILE}` };
    }
    const rc = await this.deps.docker.saveAndLoad(infraContext(), this.deps.image, targetContext);
    if (rc !== 0) return { kind: "failed", reason: `save|load rc ${rc}` };
    return { kind: "first-seed", version: infraVersion };
  }

  /** Wrap it as the callback shape VmEnsureService's deps.ensureImage wants. */
  asCallback(): (context: string) => Promise<{ ok: boolean; reason?: string }> {
    return async (context: string) => {
      const r = await this.ensure(context);
      switch (r.kind) {
        case "already-current":
        case "reseeded":
        case "first-seed":
          return { ok: true };
        case "failed":
          return { ok: false, reason: r.reason };
      }
    };
  }

  private isNewer(a: string, b: string): boolean {
    try {
      return Version.parseLoose(a).compareTo(Version.parseLoose(b)) === "gt";
    } catch { return false; }
  }
}

import type { Docker, ImageVersion } from "../infra/Docker.ts";
import { IMAGE_UNSTAMPED, IMAGE_UNAVAILABLE, infraContext, projectContext, projectProfile } from "../infra/Docker.ts";
import { Version, type Severity } from "../domain/Version.ts";

/**
 * The compare-and-decide logic for `dridock checkversion`. Pure over the
 * three inputs (host wrapper semver + cb-infra image label + optional
 * per-project image label). Renders no output — the command wraps this
 * with prose. Ports the decision branches at wrapper.sh:1122-1158.
 */

export interface CheckVersionInputs {
  readonly wrapperVersion: string;
  readonly infraImageVersion: ImageVersion;
  /** Absent for "no dridock project in $PWD" — matches the `[ -n "$cid" ]` branch. */
  readonly projectImageVersion?: ImageVersion;
  readonly projectId?: string;
}

export type CheckVersionOutcome =
  | { kind: "in-sync"; version: string }
  | { kind: "reseed-needed"; wrapperVersion: string; projectVersion: string; infraVersion: string }
  | { kind: "no-comparable"; reason: "predates-versioning" | "vms-down" }
  | { kind: "drift"; wrapperVersion: string; imageVersion: string; severity: Severity; direction: "wrapper-newer" | "image-newer" };

export class CheckVersionService {
  constructor(private readonly docker: Docker, private readonly imageName: string) {}

  /**
   * Collect the three version strings + classify.
   */
  async evaluate(wrapperVersion: string, projectId: string | undefined): Promise<CheckVersionInputs & { outcome: CheckVersionOutcome }> {
    const infra = await this.docker.imageVersion(infraContext(), this.imageName);
    const project = projectId !== undefined
      ? await this.docker.imageVersion(projectContext(projectId), this.imageName)
      : undefined;
    const inputs: CheckVersionInputs = {
      wrapperVersion,
      infraImageVersion: infra,
      projectImageVersion: project,
      projectId,
    };
    return { ...inputs, outcome: classify(inputs) };
  }
}

/** The compare/classify (matches wrapper.sh:1122-1158 branches). */
export function classify(inputs: CheckVersionInputs): CheckVersionOutcome {
  const wv = inputs.wrapperVersion;
  const pReal = realVersion(inputs.projectImageVersion);
  const cReal = realVersion(inputs.infraImageVersion);

  // "cb-infra current + this project's VM behind" — needs a reseed, not a rebuild.
  // Matches wrapper.sh:1128-1133.
  if (inputs.projectId !== undefined && cReal !== undefined && cReal === wv && pReal !== cReal) {
    return {
      kind: "reseed-needed",
      wrapperVersion: wv,
      projectVersion: pReal ?? String(inputs.projectImageVersion),
      infraVersion: cReal,
    };
  }

  // Nothing comparable — either both are "unstamped" (pre-versioning image) or
  // both are "unavailable" (VMs down). Matches wrapper.sh:1134-1141.
  const cmp = pReal ?? cReal;
  if (cmp === undefined) {
    if (inputs.projectImageVersion === IMAGE_UNSTAMPED || inputs.infraImageVersion === IMAGE_UNSTAMPED) {
      return { kind: "no-comparable", reason: "predates-versioning" };
    }
    return { kind: "no-comparable", reason: "vms-down" };
  }

  if (cmp === wv) return { kind: "in-sync", version: wv };

  // Drift.
  const w = Version.parseLoose(wv);
  const i = Version.parseLoose(cmp);
  const severity = w.skewSeverity(i);
  const direction = w.compareTo(i) === "gt" ? "wrapper-newer" : "image-newer";
  return { kind: "drift", wrapperVersion: wv, imageVersion: cmp, severity, direction };
}

/** A concrete comparable semver, or undefined for unstamped/unavailable/blank.
 *  Ports cb_real_ver. */
function realVersion(v: ImageVersion | undefined): string | undefined {
  if (v === undefined || v === "" || v === IMAGE_UNSTAMPED || v === IMAGE_UNAVAILABLE) return undefined;
  return v;
}

// Re-export the context-name helpers for the command's rendering.
export { infraContext, projectContext, projectProfile };

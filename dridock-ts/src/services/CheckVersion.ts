import type { Docker, ImageVersion } from "../infra/Docker.ts";
import { IMAGE_UNSTAMPED, IMAGE_UNAVAILABLE, infraContext, projectContext, projectProfile } from "../infra/Docker.ts";
import { Version, type Severity } from "../domain/Version.ts";
import { CLAUDE_CLI_LABEL } from "./ImageEnsureService.ts";

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
  /** The baked claude CLI version from the project image (only fetched
   *  when projectId is set — matches bash's `if [ -n "$cid" ]`).
   *  IMAGE_UNAVAILABLE when the docker call failed. */
  readonly claudeCliVersion?: ImageVersion;
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
    // Only fetch claude CLI version when we have a project image to run
    // against — matches bash's `if [ -n "$cid" ]` gating at wrapper.sh:1085.
    const claudeCli = projectId !== undefined
      ? await this.docker.imageClaudeCliVersion(projectContext(projectId), this.imageName)
      : undefined;
    const inputs: CheckVersionInputs = {
      wrapperVersion,
      infraImageVersion: infra,
      projectImageVersion: project,
      projectId,
      claudeCliVersion: claudeCli,
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

/* ── Variant tags (#109) ─────────────────────────────────────────────────
 * The classify() above looks at ONE tag: the image dridock runs. A host can
 * also hold the other variant (`latest` vs `latest-minimal`), built by a
 * different command at a different time, and nothing reported it. Arfy's
 * host had `dridock:latest-minimal` at harness 4.3.4 / claude 2.1.215 next to
 * a current full image, and checkversion printed "✅ in sync". These
 * functions look at every variant tag present in cb-infra. They read only
 * image labels: no container spawn, no network.
 */

export const LABEL_VERSION = "org.dridock.version";
export const LABEL_VERSION_LEGACY = "org.claudebox.version";
/** Added by #78 and shared with reseed's drift check, so both read the same
 *  label. An image built before #78 carries none. */
const LABEL_CLAUDE = CLAUDE_CLI_LABEL;

export interface VariantInput {
  readonly tag: string;
  /** Label map from `docker image inspect`; undefined = tag not present. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface VariantReport {
  readonly tag: string;
  readonly present: boolean;
  readonly inUse: boolean;
  /** Harness semver from the labels, or undefined when unstamped/absent. */
  readonly version?: string;
  /** Baked claude CLI from the label, or undefined when the label is absent. */
  readonly claude?: string;
  /** One human-readable line per thing wrong with this tag. Empty = fine. */
  readonly problems: readonly string[];
}

export interface VariantAssessmentInput {
  readonly wrapperVersion: string;
  /** The tag dridock runs (from ImageRef). */
  readonly inUse: string;
  /** `ARG CLAUDE_VERSION` from the checkout's Dockerfile, when there is one. */
  readonly pin?: string;
  readonly variants: readonly VariantInput[];
}

export function assessVariants(input: VariantAssessmentInput): VariantReport[] {
  const read = input.variants.map((v) => {
    const labels = v.labels;
    const version = labels === undefined ? undefined : realLabel(labels[LABEL_VERSION] ?? labels[LABEL_VERSION_LEGACY]);
    const claude = labels === undefined ? undefined : realLabel(labels[LABEL_CLAUDE]);
    return { tag: v.tag, present: labels !== undefined, inUse: v.tag === input.inUse, version, claude };
  });
  // Without a checkout there is no pin to read. The tag in use is then the
  // best reference for "what claude should the others bake": both variants
  // are built from one ARG, so a difference means one of them is older.
  const inUseClaude = read.find((r) => r.inUse && r.present)?.claude;

  return read.map((r) => {
    const problems: string[] = [];
    if (!r.present) return { ...r, problems };
    if (r.version === undefined) {
      problems.push(`no ${LABEL_VERSION} label: the image predates versioning`);
    } else if (!r.inUse && r.version !== input.wrapperVersion) {
      // The tag in use is already compared by classify(); don't say it twice.
      problems.push(`harness ${r.version}, but the wrapper is ${input.wrapperVersion}`);
    }
    if (r.claude === undefined) {
      // LOAD-BEARING: this must be a PROBLEM, not "unknown". The real stale
      // image that motivated #109 has no claude label at all. Treating that
      // as nothing-to-compare reports it clean, which is the bug.
      problems.push(`no ${LABEL_CLAUDE} label: built before #78, so its claude CLI is unrecorded (likely stale)`);
    } else if (input.pin !== undefined) {
      if (r.claude !== input.pin) problems.push(`bakes claude ${r.claude}, but the Dockerfile pins ${input.pin}`);
    } else if (!r.inUse && inUseClaude !== undefined && r.claude !== inUseClaude) {
      problems.push(`bakes claude ${r.claude}, but ${input.inUse} bakes ${inUseClaude}`);
    }
    return { ...r, problems };
  });
}

/** `ARG CLAUDE_VERSION=<v>` from a Dockerfile's text; the first one wins,
 *  matching install.sh's `sed -n … | head -1`. */
export function dockerfilePin(dockerfile: string): string | undefined {
  const m = /^ARG CLAUDE_VERSION=(\S+)/m.exec(dockerfile);
  return m?.[1];
}

function realLabel(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" || t === "<no value>" ? undefined : t;
}

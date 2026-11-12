import type { Docker, ImageVersion } from "../infra/Docker.ts";
import { IMAGE_UNAVAILABLE, IMAGE_UNSTAMPED, infraContext } from "../infra/Docker.ts";
import type { EnvResolver } from "../domain/EnvResolver.ts";
import type { FileSystem } from "../infra/FileSystem.ts";
import { Version } from "../domain/Version.ts";
import { makeTargetFor, type ImageChoice } from "../domain/ImageRef.ts";

/**
 * The launch-time warning that the cb-infra image is out of step with this
 * wrapper (#110). Never blocks.
 *
 * 3.x printed this on every launch (`cb_check_infra_drift`, wrapper.sh at
 * v3.4.1 lines 299–323). The 4.0 TS port dropped it, while
 * docs/environment-variables.md kept documenting it and its opt-out
 * `DRIDOCK_NO_DRIFT_WARN`. After that, `checkversion` reported drift only
 * when someone thought to run it. That's how `dridock:latest-minimal` sat ten
 * releases behind with nothing saying so (#109).
 *
 * The check runs on THIS launch's state: the image the resolver picked for
 * this invocation (ImageRef, so `DRIDOCK_MINIMAL=1` checks
 * `latest-minimal`, not `latest`), read from cb-infra now. Nothing is
 * cached between runs.
 *
 * Silent when: the opt-out is set; this is the harness checkout itself, by
 * fingerprint or `DRIDOCK_HARNESS_DEV` / legacy `DRIDOCK_FRAMEWORK_DEV`,
 * read the way entrypoint.sh reads them (whoever is working there is the
 * one causing the drift, and the wrapper moves ahead of the image as soon
 * as they bump VERSION); cb-infra is
 * unreachable or the image is unstamped (`checkversion` explains those);
 * versions match.
 */

/** The file only a harness checkout has; same fingerprint as `harness sync`
 *  and checkversion's pin reader. */
export const HARNESS_FINGERPRINT = "dridock-ts/src/domain/dridockVersion.ts";

export interface DriftWarningInput {
  readonly wrapperVersion: string;
  readonly infraVersion: ImageVersion;
  /** The image this invocation runs, and how it was chosen (ImageRef). */
  readonly image: string;
  readonly variant: ImageChoice["variant"];
  readonly binName: string;
}

/** The stderr lines to print; empty when there is nothing to say. Pure. */
export function driftWarningLines(input: DriftWarningInput): string[] {
  const iv = input.infraVersion;
  if (iv === "" || iv === IMAGE_UNAVAILABLE || iv === IMAGE_UNSTAMPED) return [];
  const wv = input.wrapperVersion;
  if (iv === wv) return [];

  const w = Version.parseLoose(wv);
  const i = Version.parseLoose(iv);
  const tag = input.image;
  if (w.compareTo(i) === "lt") {
    return [
      `⚠️  cb-infra image ${tag} (${iv}) is AHEAD of this wrapper (${wv}): update the wrapper with ./install.sh\n`,
      `   (${input.binName} checkversion for details; DRIDOCK_NO_DRIFT_WARN=1 silences this)\n`,
    ];
  }
  const remedy = input.variant === "custom"
    ? `rebuild or re-pull ${tag} (it comes from DRIDOCK_IMAGE, which no make target builds)`
    : makeTargetFor(tag);
  const sev = w.skewSeverity(i);
  const head = sev === "major"
    ? `🔴 cb-infra image ${tag} (${iv}) is a MAJOR version behind this wrapper (${wv}). Rebuild REQUIRED on the Mac: ${remedy}`
    : sev === "minor"
      ? `🟠 cb-infra image ${tag} (${iv}) is a MINOR version behind this wrapper (${wv}). Rebuild on the Mac: ${remedy}`
      : `🟡 cb-infra image ${tag} (${iv}) is behind this wrapper (${wv}). Rebuild when convenient: ${remedy}`;
  return [
    `${head}\n`,
    `   (fresh project VMs reseed from cb-infra; ${input.binName} checkversion for details; DRIDOCK_NO_DRIFT_WARN=1 silences this)\n`,
  ];
}

export interface DriftCheckDeps {
  readonly docker: Docker;
  readonly fs: FileSystem;
  readonly env: EnvResolver;
}

/** Reads cb-infra and decides. `projectRoot` is the resolved project root,
 *  used for the harness-checkout skip. */
export async function checkInfraDrift(
  deps: DriftCheckDeps, projectRoot: string, input: Omit<DriftWarningInput, "infraVersion">,
): Promise<string[]> {
  if (deps.env.bool("NO_DRIFT_WARN")) return [];
  // Same precedence as entrypoint.sh's `${DRIDOCK_HARNESS_DEV:-${DRIDOCK_FRAMEWORK_DEV:-}}`.
  const dev = nonEmpty(deps.env.get("HARNESS_DEV")) ?? nonEmpty(deps.env.get("FRAMEWORK_DEV"));
  if (dev !== undefined && /^(1|true|yes|on)$/i.test(dev)) return [];
  if (await deps.fs.exists(`${projectRoot}/${HARNESS_FINGERPRINT}`)) return [];
  const infraVersion = await deps.docker.imageVersion(infraContext(), input.image);
  return driftWarningLines({ ...input, infraVersion });
}

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === "" ? undefined : v;
}

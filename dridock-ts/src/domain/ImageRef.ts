import type { EnvResolver } from "./EnvResolver.ts";

/**
 * Which claudebot image dridock runs (#109).
 *
 * The 3.x bash wrapper read three settings (`wrapper.sh` at v3.4.1, lines
 * 2146–2153):
 *
 *   DRIDOCK_IMAGE       the full reference, wins outright
 *   DRIDOCK_IMAGE_NAME  the local repo name (default `dridock`)
 *   DRIDOCK_MINIMAL     any non-empty value → tag `latest-minimal`, else `latest`
 *
 * The 4.0 TS port dropped all three. Every command hardcoded `dridock:latest`,
 * while `--help`, the env-var doc, the README and the todo-app example kept
 * documenting them. So `DRIDOCK_MINIMAL=1 dridock` silently ran the full
 * image, and a host that followed `DRIDOCK_MINIMAL=1 ./install.sh` had built
 * only the tag dridock never used. This module restores the bash rules, and
 * `main` passes its result into every image-using command, so there is a
 * single place that decides.
 *
 * `DRIDOCK_MINIMAL` keeps the bash meaning, "set and non-empty", because
 * `install.sh` reads it the same way (`[ -n "$_minimal" ]`). The two must
 * agree, or `install.sh` would build one tag while dridock runs another,
 * which is this bug again. That means `DRIDOCK_MINIMAL=0` also selects
 * minimal. It's documented in docs/environment-variables.md, and this
 * resolver says so on stderr instead of letting it pass silently.
 */

export const DEFAULT_IMAGE_NAME = "dridock";
export const FULL_TAG = "latest";
export const MINIMAL_TAG = "latest-minimal";

export interface ImageChoice {
  /** The reference every command runs, e.g. `dridock:latest-minimal`. */
  readonly image: string;
  /** `custom` when DRIDOCK_IMAGE named it outright; variant tags don't apply then. */
  readonly variant: "full" | "minimal" | "custom";
  /** The repo name the variant tags hang off (`dridock` unless overridden). */
  readonly name: string;
  /** One stderr line per setting that was read but had no effect, or that
   *  likely doesn't mean what the user thinks. Never-silently-discard. */
  readonly notes: readonly string[];
}

export function resolveImage(env: EnvResolver): ImageChoice {
  const explicit = nonEmpty(env.get("IMAGE"));
  const nameSetting = nonEmpty(env.get("IMAGE_NAME"));
  const minimalRaw = env.get("MINIMAL");
  const minimal = nonEmpty(minimalRaw) !== undefined;
  const name = nameSetting ?? DEFAULT_IMAGE_NAME;
  const notes: string[] = [];

  if (explicit !== undefined) {
    if (minimal) notes.push(`ℹ️  DRIDOCK_MINIMAL is ignored: DRIDOCK_IMAGE=${explicit} names the image outright.\n`);
    if (nameSetting !== undefined) notes.push(`ℹ️  DRIDOCK_IMAGE_NAME is ignored: DRIDOCK_IMAGE=${explicit} names the image outright.\n`);
    return { image: explicit, variant: "custom", name, notes };
  }
  if (minimal && /^(0|false|no|off)$/i.test(minimalRaw!.trim())) {
    notes.push(`ℹ️  DRIDOCK_MINIMAL=${minimalRaw} selects the MINIMAL image: any non-empty value does (same as install.sh). Unset it for the full image.\n`);
  }
  return {
    image: `${name}:${minimal ? MINIMAL_TAG : FULL_TAG}`,
    variant: minimal ? "minimal" : "full",
    name,
    notes,
  };
}

/** The variant tags a host may have built under `name`, full first. */
export function variantTags(name: string): readonly [string, string] {
  return [`${name}:${FULL_TAG}`, `${name}:${MINIMAL_TAG}`];
}

/** The `make` target that rebuilds a variant tag, for remedy lines. */
export function makeTargetFor(tag: string): string {
  return tag.endsWith(`:${MINIMAL_TAG}`) ? "make build-minimal" : "make build";
}

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v.trim() === "" ? undefined : v;
}

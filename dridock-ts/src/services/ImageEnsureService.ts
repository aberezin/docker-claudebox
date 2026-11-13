import type { Docker, ImageIdentity } from "../infra/Docker.ts";
import type { Colima } from "../infra/Colima.ts";
import { infraContext, INFRA_PROFILE } from "../infra/Docker.ts";
import { Version } from "../domain/Version.ts";
import type { Progress } from "../infra/Spinner.ts";
import { NULL_PROGRESS } from "../infra/Spinner.ts";

/**
 * Seed the claudebot image into a target docker context, or reseed if
 * it's drifted below cb-infra's version. Ports cb_ensure_image at
 * wrapper.sh:696.
 *
 * Semantics:
 *   - Target has image present:
 *       - cb-infra is Running AND holds a newer version → save|load
 *         (auto-reseed after `make build`).
 *       - Same version, but a different image ID (a CLI-only rebuild, #78,
 *         or a baked-file fix with no VERSION bump, #118) → save|load.
 *       - cb-infra stopped, or holding no comparable version → the drift
 *         question is UNANSWERED: return `unverified` (not `already-current`)
 *         and emit a note, so a stale image is never silently blessed. #76.
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
  /**
   * Sink for user-visible notes that are not failures. Defaults to a no-op
   * so tests and non-interactive callers stay quiet. Used for the
   * "drift not checked" note — see `unverified` below.
   */
  readonly warn?: (message: string) => void;
  /**
   * Reseed unconditionally, skipping every drift comparison. The escape
   * hatch for cases the comparison cannot resolve on its own -- chiefly
   * images built before `org.dridock.claude-version` existed, where the CLI
   * check reports `unverified` forever until something forces the copy (#78).
   * Set from DRIDOCK_FORCE_RESEED by the callers.
   */
  readonly force?: boolean;
  /**
   * Reporter for the save|load, which takes 15-45s with both docker stderr
   * streams swallowed — the one window a cold-path `start` still sat
   * silent through after #48. Defaults to NULL_PROGRESS, so a caller that
   * supplies nothing behaves exactly as before.
   */
  readonly progress?: Progress;
}

/** Label carrying the pinned Claude CLI version, stamped by the Dockerfile. */
export const CLAUDE_CLI_LABEL = "org.dridock.claude-version";

/**
 * Interpret DRIDOCK_FORCE_RESEED. Unset/empty is off. A value we don't
 * recognise is NOT silently treated as off -- it is a user-supplied input we
 * are declining to act on, so it gets a stderr line naming what was accepted
 * (repo rule: never silently discard user input).
 */
export function parseForceReseed(
  raw: string | undefined,
  warn?: (message: string) => void,
): boolean {
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  warn?.(
    `!  DRIDOCK_FORCE_RESEED='${raw}' not understood — ignoring it and using the normal drift check.\n` +
    `   Accepted: 1/true/yes to force, 0/false/no to disable.\n`,
  );
  return false;
}

export type ImageEnsureOutcome =
  | { readonly kind: "already-current"; readonly version: string }
  /**
   * Image is present and usable, but we could NOT compare it against
   * cb-infra — so we do not know whether it has drifted. Distinct from
   * `already-current`, which means we checked and it is current. Callers
   * proceed normally (ok: true); the difference exists so "didn't check"
   * is never reported as "up to date". See #76.
   */
  | { readonly kind: "unverified"; readonly version: string; readonly reason: string }
  | {
      readonly kind: "reseeded";
      readonly from: string;
      readonly to: string;
      /** Why, when it wasn't the harness semver (e.g. a CLI-only rebuild). */
      readonly reason?: string;
    }
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
      if (!infraRunning) {
        return {
          kind: "unverified",
          version: targetVersion,
          reason: `${INFRA_PROFILE} is not running`,
        };
      }

      const infraVersion = await this.deps.docker.imageVersion(infraContext(), this.deps.image);

      // Escape hatch: copy whatever cb-infra holds, no questions asked. Checked
      // before the comparisons precisely because its purpose is the cases the
      // comparisons cannot settle.
      if (this.deps.force === true && infraVersion !== "unavailable") {
        const rc = await this.reseed(targetContext);
        if (rc !== 0) return { kind: "failed", reason: `save|load rc ${rc}` };
        return {
          kind: "reseeded", from: targetVersion, to: infraVersion,
          reason: "forced (DRIDOCK_FORCE_RESEED)",
        };
      }

      if (infraVersion === "unavailable" || infraVersion === "unstamped") {
        // cb-infra is up but has nothing comparable to offer, so the drift
        // question stays unanswered — same reporting rule as it being down.
        return {
          kind: "unverified",
          version: targetVersion,
          reason: `${this.deps.image} is ${infraVersion} in ${INFRA_PROFILE}`,
        };
      }
      if (targetVersion === "unstamped" || this.isNewer(infraVersion, targetVersion)) {
        const rc = await this.reseed(targetContext);
        if (rc !== 0) return { kind: "failed", reason: `save|load rc ${rc}` };
        return { kind: "reseeded", from: targetVersion, to: infraVersion };
      }

      // The harness semver says we're level. That is NOT the whole story.
      // Two builds can carry the same labels and still differ: a
      // `--claude-version` rebuild changes the CLI while DRIDOCK_VERSION
      // stays put (#78), and any baked-file fix that, under our versioning
      // rule, ships without a VERSION bump changes the image and NO label
      // at all (#118 -- #115's shim fix never reached the project VM).
      //
      // So compare the image ID. `docker save | docker load` carries the ID
      // across (it is the config digest), which makes it a build identity:
      // equal → same build, different → cb-infra holds a different one, and
      // cb-infra is the source of truth for what gets deployed. LOAD-BEARING:
      // if save|load ever stopped preserving the ID, every launch would
      // reseed (loud: a 15-45s progress phase each time), never the reverse.
      //
      // Only when the semvers are EQUAL. If the target is somehow newer we
      // leave it alone rather than downgrading the whole image.
      if (targetVersion === infraVersion) {
        const infraIdent = await this.deps.docker.imageIdentity(infraContext(), this.deps.image);
        const targetIdent = await this.deps.docker.imageIdentity(targetContext, this.deps.image);
        const infraCli = cliOf(infraIdent);
        const targetCli = cliOf(targetIdent);

        if (infraIdent !== undefined && targetIdent !== undefined) {
          if (infraIdent.id === targetIdent.id) {
            return { kind: "already-current", version: targetVersion };
          }
          const rc = await this.reseed(targetContext);
          if (rc !== 0) return { kind: "failed", reason: `save|load rc ${rc}` };
          return {
            kind: "reseeded",
            from: targetVersion,
            to: infraVersion,
            reason: infraCli !== undefined && targetCli !== undefined && infraCli !== targetCli
              ? `claude CLI ${targetCli} → ${infraCli}`
              : `same version label, different build (${shortId(targetIdent.id)} → ${shortId(infraIdent.id)})`,
          };
        }

        // An ID we couldn't read: fall back to the labels, which is all the
        // pre-#118 code had. Reached only when an inspect failed on a side
        // whose version label we DID read, i.e. rarely.
        if (infraCli === undefined && targetCli === undefined) {
          // NEITHER side carries the stamp: both images predate it. Nothing is
          // knowable from labels, so stay silent rather than nag every launch.
          return { kind: "already-current", version: targetVersion };
        }
        if (infraCli === undefined || targetCli === undefined) {
          // Exactly ONE side is stamped -- genuinely ambiguous without an ID,
          // so report it rather than guess either way (#76 rule).
          // DRIDOCK_FORCE_RESEED is the way across.
          return {
            kind: "unverified",
            version: targetVersion,
            reason: `${targetCli === undefined ? "this project's image" : "cb-infra's image"} predates the ${CLAUDE_CLI_LABEL} stamp`,
          };
        }
        if (infraCli !== targetCli) {
          const rc = await this.reseed(targetContext);
          if (rc !== 0) return { kind: "failed", reason: `save|load rc ${rc}` };
          return {
            kind: "reseeded",
            from: targetVersion,
            to: infraVersion,
            reason: `claude CLI ${targetCli} → ${infraCli}`,
          };
        }
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
    const rc = await this.reseed(targetContext);
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
        case "unverified":
          // Not a failure: the image works and we proceed. But say so, or
          // a stale image after a `make build` is invisible forever.
          this.deps.warn?.(
            `!  image drift not checked (${r.reason}) — using ${this.deps.image} ${r.version}, which may be behind.\n` +
            `   'colima start -p ${INFRA_PROFILE}' then re-run, or DRIDOCK_FORCE_RESEED=1 to copy it regardless.\n`,
          );
          return { ok: true };
        case "failed":
          return { ok: false, reason: r.reason };
      }
    };
  }

  /**
   * The save|load, wrapped in progress reporting. A helper rather than four
   * inline try/finally blocks: forgetting the finally at ONE site leaves a
   * dangling spinner row that the next status line writes into the middle
   * of, and that site would be whichever one nobody exercises.
   */
  private async reseed(targetContext: string): Promise<number> {
    const from = INFRA_PROFILE;
    const to = targetContext.replace(/^colima-/, "");
    const done = (this.deps.progress ?? NULL_PROGRESS).begin(`seeding image ${from} → ${to}`);
    let rc = 1;
    try {
      rc = await this.deps.docker.saveAndLoad(infraContext(), this.deps.image, targetContext);
      return rc;
    } finally {
      done(rc === 0
        ? { summary: `image seeded ${from} → ${to}` }
        : { ok: false, summary: `image seed FAILED ${from} → ${to} (rc ${rc})` });
    }
  }

  private isNewer(a: string, b: string): boolean {
    try {
      return Version.parseLoose(a).compareTo(Version.parseLoose(b)) === "gt";
    } catch { return false; }
  }
}

/** Pinned CLI version off the image label, or undefined when absent. */
function cliOf(ident: ImageIdentity | undefined): string | undefined {
  const v = ident?.labels[CLAUDE_CLI_LABEL];
  return v === undefined || v === "" ? undefined : v;
}

/** `sha256:1daa83165f3c…` → `1daa83165f3c`, the form `docker image ls` prints. */
function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

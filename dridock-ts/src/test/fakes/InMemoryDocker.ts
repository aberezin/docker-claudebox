import type { Docker, ImageVersion, ImageIdentity, ContainerIdentity, RunCaptureOpts } from "../../infra/Docker.ts";
import { IMAGE_UNAVAILABLE } from "../../infra/Docker.ts";

/**
 * Fake Docker for unit tests — seed image labels + identities +
 * container inspects + throwaway-run outputs per (context, image) without
 * a running dockerd. Keys are `${context}\0${image}` (or
 * `${context}\0${containerName}` for container-scoped ops).
 */
export class InMemoryDocker implements Docker {
  private readonly labels = new Map<string, ImageVersion>();
  private readonly claudeVersions = new Map<string, ImageVersion>();
  private readonly imageIdentities = new Map<string, ImageIdentity>();
  private readonly containerIdentities = new Map<string, ContainerIdentity>();
  private readonly runCaptures = new Map<string, { rc: number; stdout: string }>();
  /** Records for what would have happened server-side. */
  readonly saves: Array<{ source: string; image: string; target: string }> = [];
  readonly removals: Array<{ context: string; name: string }> = [];
  readonly runCalls: Array<{ context: string | undefined; image: string; opts: RunCaptureOpts }> = [];
  /** rc for saveAndLoad — default 0. Set > 0 for failure scenarios. */
  nextSaveAndLoadRc = 0;

  /* ── seed helpers ─────────────────────────────────────────────────── */

  seedImage(context: string | undefined, image: string, version: ImageVersion): void {
    this.labels.set(this.key(context, image), version);
  }
  seedClaudeCliVersion(context: string | undefined, image: string, version: ImageVersion): void {
    this.claudeVersions.set(this.key(context, image), version);
  }
  seedImageIdentity(context: string, image: string, identity: ImageIdentity): void {
    this.imageIdentities.set(this.key(context, image), identity);
  }
  seedContainer(context: string, containerName: string, identity: ContainerIdentity): void {
    this.containerIdentities.set(this.key(context, containerName), identity);
  }
  /** Seed the outcome of a specific runCapture — key = args joined by space. */
  seedRunCapture(image: string, args: readonly string[], rc: number, stdout: string): void {
    this.runCaptures.set(`${image}\0${args.join(" ")}`, { rc, stdout });
  }

  /** Fallback outcome for any runCapture whose args aren't seeded. Useful
   *  for tests that don't want to match a long shell script byte-for-byte —
   *  set this and every subsequent runCapture returns it. Default undefined =
   *  fall through to rc 127. */
  runCaptureFallback: { rc: number; stdout: string } | undefined;

  /* ── Docker interface impl ────────────────────────────────────────── */

  async imageVersion(context: string | undefined, image: string): Promise<ImageVersion> {
    return this.labels.get(this.key(context, image)) ?? IMAGE_UNAVAILABLE;
  }

  async imageClaudeCliVersion(context: string | undefined, image: string): Promise<ImageVersion> {
    return this.claudeVersions.get(this.key(context, image)) ?? IMAGE_UNAVAILABLE;
  }

  async imageIdentity(context: string, image: string): Promise<ImageIdentity | undefined> {
    return this.imageIdentities.get(this.key(context, image));
  }

  async containerIdentity(context: string, containerName: string): Promise<ContainerIdentity | undefined> {
    return this.containerIdentities.get(this.key(context, containerName));
  }

  async containerRemove(context: string, containerName: string): Promise<void> {
    this.removals.push({ context, name: containerName });
    this.containerIdentities.delete(this.key(context, containerName));
  }

  async saveAndLoad(sourceContext: string, image: string, targetContext: string): Promise<number> {
    this.saves.push({ source: sourceContext, image, target: targetContext });
    if (this.nextSaveAndLoadRc === 0) {
      // Model the successful save|load: target now has the same identity
      // as source (if source seeded), and the same version.
      const sourceId = this.imageIdentities.get(this.key(sourceContext, image));
      if (sourceId !== undefined) this.imageIdentities.set(this.key(targetContext, image), sourceId);
      const sourceVer = this.labels.get(this.key(sourceContext, image));
      if (sourceVer !== undefined) this.labels.set(this.key(targetContext, image), sourceVer);
    }
    return this.nextSaveAndLoadRc;
  }

  async runCapture(context: string | undefined, image: string, opts: RunCaptureOpts): Promise<{ rc: number; stdout: string }> {
    void context;
    this.runCalls.push({ context, image, opts });
    return this.runCaptures.get(`${image}\0${opts.args.join(" ")}`) ?? this.runCaptureFallback ?? { rc: 127, stdout: "" };
  }

  readonly imagePrunes: Array<{ context: string; reclaimed: string }> = [];
  readonly builderPrunes: Array<{ context: string; reclaimed: string }> = [];
  /** Reclaimed strings scripted for the NEXT prune calls — default "0B". */
  nextImagePruneReclaimed = "0B";
  nextBuilderPruneReclaimed = "0B";

  async imagePrune(context: string): Promise<{ rc: number; reclaimed: string }> {
    const reclaimed = this.nextImagePruneReclaimed;
    this.imagePrunes.push({ context, reclaimed });
    return { rc: 0, reclaimed };
  }

  async builderPrune(context: string): Promise<{ rc: number; reclaimed: string }> {
    const reclaimed = this.nextBuilderPruneReclaimed;
    this.builderPrunes.push({ context, reclaimed });
    return { rc: 0, reclaimed };
  }

  private key(context: string | undefined, image: string): string {
    return `${context ?? "default"}\0${image}`;
  }
}

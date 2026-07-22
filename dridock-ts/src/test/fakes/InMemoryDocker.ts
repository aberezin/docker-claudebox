import type { Docker, ImageVersion } from "../../infra/Docker.ts";
import { IMAGE_UNAVAILABLE } from "../../infra/Docker.ts";

/**
 * Fake Docker for unit tests — seed image labels per (context, image)
 * without a running dockerd. Keys are `${context}\0${image}` — pass
 * `undefined` context as the string "default".
 */
export class InMemoryDocker implements Docker {
  private readonly labels = new Map<string, ImageVersion>();

  /** Seed the "next `imageVersion(ctx, img)` returns X" outcome. */
  seedImage(context: string | undefined, image: string, version: ImageVersion): void {
    this.labels.set(this.key(context, image), version);
  }

  async imageVersion(context: string | undefined, image: string): Promise<ImageVersion> {
    return this.labels.get(this.key(context, image)) ?? IMAGE_UNAVAILABLE;
  }

  private key(context: string | undefined, image: string): string {
    return `${context ?? "default"}\0${image}`;
  }
}

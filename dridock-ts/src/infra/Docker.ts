/**
 * Narrow port of what wrapper.sh calls on the `docker` binary. Kept small
 * on purpose — commands touch only the primitives they need, and this
 * interface grows one method per Phase 2/3/4 addition instead of
 * mirroring the full docker CLI.
 *
 * Real impl shells out via Bun.spawn (no docker-node client dep). Fake
 * impl in `src/test/fakes/InMemoryDocker.ts` lets unit tests seed image
 * labels + version strings without a running dockerd.
 */

/** One of: a real semver string ("3.3.7"), the literal strings "unstamped"
 *  (image exists but has no version label) or "unavailable" (image doesn't
 *  exist in this context — e.g. the VM is down). Matches wrapper.sh's
 *  cb_image_status contract exactly. */
export type ImageVersion = string;
export const IMAGE_UNSTAMPED = "unstamped" as const;
export const IMAGE_UNAVAILABLE = "unavailable" as const;

/** Compact identity of a docker image — id + labels — used for reseed
 *  drift detection (`cb_ensure_image` / `cb_refresh_container`). */
export interface ImageIdentity {
  /** The `sha256:…` id from `docker image inspect --format {{.Id}}`. */
  readonly id: string;
  /** Whole label map. Callers pluck what they need. */
  readonly labels: Readonly<Record<string, string>>;
}

/** Compact `docker inspect --format` output for a container. */
export interface ContainerIdentity {
  readonly name: string;
  /** `.Image` — the SHA the container was created from. Diffs against
   *  `image inspect` `.Id` for `cb_refresh_container`. */
  readonly imageId: string;
  /** Docker status string, e.g. "Up 3 minutes", "Exited (0) 5 min ago". */
  readonly status?: string;
}

export interface Docker {
  /**
   * Read the org.dridock.version label off an image inside a docker
   * context. `context` is what `--context` takes (e.g. "colima-cb-infra");
   * pass `undefined` to use the default docker context.
   *
   * Ports cb_image_status: reads org.dridock.version, falls back to
   * org.claudebox.version, then returns "unstamped" if label missing
   * (empty or "<no value>" per Go template semantics) and "unavailable"
   * if the docker command itself failed (VM down / image absent).
   */
  imageVersion(context: string | undefined, image: string): Promise<ImageVersion>;

  /**
   * Run `claude --version` inside the image via a throwaway container
   * and return the trimmed first line, or IMAGE_UNAVAILABLE if the
   * container-run failed / output was empty. Ports cb_image_claude_version
   * at wrapper.sh:973 — strips the "(Claude Code)" suffix on success.
   *
   * The claude CLI is a separate axis from the harness semver (that's
   * imageVersion); this one decides which claude flags are real. Auto-
   * update is disabled in the image so this only moves on a rebuild.
   */
  imageClaudeCliVersion(context: string | undefined, image: string): Promise<ImageVersion>;

  /**
   * `docker image inspect` — returns id + label map, or undefined if the
   * image isn't present (VM down / image absent). Used by
   * ImageEnsureService for reseed drift detection.
   */
  imageIdentity(context: string, image: string): Promise<ImageIdentity | undefined>;

  /**
   * `docker container inspect --format` on one container name. Returns
   * name + created-from image id + docker status string. undefined when
   * the container doesn't exist. Used by cb_refresh_container equivalent.
   */
  containerIdentity(context: string, containerName: string): Promise<ContainerIdentity | undefined>;

  /**
   * `docker rm -f <container>` — force-remove. No-op if absent. Used by
   * cb_refresh_container after label mismatch.
   */
  containerRemove(context: string, containerName: string): Promise<void>;

  /**
   * Pipe `docker save $image` on `sourceContext` into `docker load` on
   * `targetContext`. Best-effort — returns rc 0 iff both ends succeeded.
   * Ports the `save | load` pipeline in cb_ensure_image at
   * wrapper.sh:707 + :714. Big-image blocking op (multi-second at least).
   */
  saveAndLoad(sourceContext: string, image: string, targetContext: string): Promise<number>;

  /**
   * Run a throwaway container and capture its stdout — `docker run --rm`.
   * Used for `features info` (cat manifest.yml) and other one-shot reads.
   * Returns {rc, stdout} — never throws for exec failure.
   */
  runCapture(context: string | undefined, image: string, opts: RunCaptureOpts): Promise<{ rc: number; stdout: string }>;
}

export interface RunCaptureOpts {
  /** Override the image's ENTRYPOINT (e.g. "sh" or "cat"). */
  readonly entrypoint?: string;
  /** Args passed to the image / entrypoint. */
  readonly args: readonly string[];
}

/** Production impl. */
export class RealDocker implements Docker {
  async imageClaudeCliVersion(context: string | undefined, image: string): Promise<ImageVersion> {
    // `docker run --rm --entrypoint claude <image> --version` → first
    // line; strips " (Claude Code)" suffix. Bash-parity for
    // cb_image_claude_version at wrapper.sh:973.
    const args = [
      "docker",
      ...(context !== undefined ? ["--context", context] : []),
      "run", "--rm", "--entrypoint", "claude", image, "--version",
    ];
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return IMAGE_UNAVAILABLE;
      const firstLine = text.split(/\r?\n/)[0] ?? "";
      const trimmed = firstLine.replace(/\s*\(Claude Code\)\s*$/, "").trim();
      if (trimmed === "") return IMAGE_UNAVAILABLE;
      return trimmed;
    } catch {
      return IMAGE_UNAVAILABLE;
    }
  }

  async imageVersion(context: string | undefined, image: string): Promise<ImageVersion> {
    // `{{ or (index .Config.Labels "org.dridock.version") (index .Config.Labels
    // "org.claudebox.version") }}` — a Go template that returns the new label
    // if set, else the legacy label, else "<no value>". Matches wrapper.sh:1004.
    const args = [
      "docker",
      ...(context !== undefined ? ["--context", context] : []),
      "image", "inspect", image,
      "--format", '{{ or (index .Config.Labels "org.dridock.version") (index .Config.Labels "org.claudebox.version") }}',
    ];
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const text = (await new Response(proc.stdout).text()).trim();
      const rc = await proc.exited;
      if (rc !== 0) return IMAGE_UNAVAILABLE;
      if (text === "" || text === "<no value>") return IMAGE_UNSTAMPED;
      return text;
    } catch {
      return IMAGE_UNAVAILABLE;
    }
  }

  async imageIdentity(context: string, image: string): Promise<ImageIdentity | undefined> {
    // `--format {json .}` isn't universally supported; use two Go-templates
    // separated by a delimiter to get id + labels in one shot.
    const args = [
      "docker", "--context", context, "image", "inspect", image,
      "--format", "{{.Id}}{{json .Config.Labels}}",
    ];
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return undefined;
      const line = text.split(/\r?\n/)[0] ?? "";
      const [id, labelsJson] = line.split("");
      if (id === undefined || id === "" || labelsJson === undefined) return undefined;
      // Labels can be `null` when the image has none — Go's `{{json}}` emits
      // `null` in that case, which JSON.parse accepts as `null`.
      const parsed = JSON.parse(labelsJson) as Record<string, string> | null;
      return { id, labels: parsed ?? {} };
    } catch {
      return undefined;
    }
  }

  async containerIdentity(context: string, containerName: string): Promise<ContainerIdentity | undefined> {
    const args = [
      "docker", "--context", context, "container", "inspect", containerName,
      "--format", "{{.Image}}{{.State.Status}}",
    ];
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return undefined;
      const line = text.split(/\r?\n/)[0] ?? "";
      const [imageId, status] = line.split("");
      if (imageId === undefined || imageId === "") return undefined;
      return { name: containerName, imageId, status };
    } catch {
      return undefined;
    }
  }

  async containerRemove(context: string, containerName: string): Promise<void> {
    const proc = Bun.spawn(["docker", "--context", context, "rm", "-f", containerName], {
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited;
    // rc discarded — `rm -f` on an absent container is "not found" which
    // we treat as success (idempotent, matches bash `|| true` shape).
  }

  async saveAndLoad(sourceContext: string, image: string, targetContext: string): Promise<number> {
    // Pipe stdout of `docker save` into stdin of `docker load`. Both
    // stderr are swallowed to match bash (`>/dev/null`).
    const save = Bun.spawn(["docker", "--context", sourceContext, "save", image], {
      stdout: "pipe", stderr: "ignore",
    });
    const load = Bun.spawn(["docker", "--context", targetContext, "load"], {
      stdin: save.stdout, stdout: "ignore", stderr: "ignore",
    });
    const [saveRc, loadRc] = await Promise.all([save.exited, load.exited]);
    return saveRc === 0 && loadRc === 0 ? 0 : Math.max(saveRc, loadRc);
  }

  async runCapture(context: string | undefined, image: string, opts: RunCaptureOpts): Promise<{ rc: number; stdout: string }> {
    const args = [
      "docker",
      ...(context !== undefined ? ["--context", context] : []),
      "run", "--rm",
      ...(opts.entrypoint !== undefined ? ["--entrypoint", opts.entrypoint] : []),
      image,
      ...opts.args,
    ];
    try {
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      return { rc, stdout };
    } catch {
      return { rc: 1, stdout: "" };
    }
  }
}

/**
 * Deterministic docker-context / colima-profile helpers. These are pure
 * name-formatting — kept next to the Docker interface because they name
 * the contexts you'd pass to Docker methods.
 *
 * Ports:
 *   cb_infra_context()   -> `colima-${CB_INFRA_PROFILE}`  (fixed "cb-infra")
 *   cb_project_context() -> `colima-cb-${id}`
 *   cb_project_profile() -> `cb-${id}`
 */
export const INFRA_PROFILE = "cb-infra";
export function infraContext(): string { return `colima-${INFRA_PROFILE}`; }
export function projectProfile(id: string): string { return `cb-${id}`; }
export function projectContext(id: string): string { return `colima-cb-${id}`; }

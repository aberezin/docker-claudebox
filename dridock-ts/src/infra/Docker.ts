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

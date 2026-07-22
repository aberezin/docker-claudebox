import type { FileSystem } from "../infra/FileSystem.ts";
import type { GitToplevel } from "../infra/GitToplevel.ts";

/**
 * Locates a project's root and reveals which metadata dir it uses. Ports
 * wrapper.sh's `cb_project_root` + `cb_project_dot` + `cb_project_dot_basename`.
 *
 * The 3.0+ convention is `<root>/.dridock/`; legacy 2.x is `<root>/.claudebox/`.
 * If both exist, `.dridock` wins (migration in progress); if only legacy exists,
 * we use it; if NEITHER exists, we return the canonical `.dridock` path so
 * bootstrap has somewhere to write.
 */
export interface ResolvedProject {
  readonly root: string;
  /** Absolute path to the metadata dir (…/.dridock or …/.claudebox). */
  readonly dotDir: string;
  /** Just the basename — for user-facing messages. */
  readonly dotName: ".dridock" | ".claudebox";
  /** Absolute path to `config.yml` inside the dot dir (may not exist yet). */
  readonly configPath: string;
}

export class ProjectRootResolver {
  constructor(
    private readonly fs: FileSystem,
    private readonly git: GitToplevel,
  ) {}

  /** Resolve the project root for `cwd` — git toplevel if available,
   *  otherwise cwd itself. Never throws. */
  async resolve(cwd: string): Promise<ResolvedProject> {
    const root = (await this.git.topLevel(cwd)) ?? cwd;
    const newDot = `${root}/.dridock`;
    const oldDot = `${root}/.claudebox`;

    let dotDir: string;
    let dotName: ".dridock" | ".claudebox";
    if (await this.fs.isDirectory(newDot)) {
      dotDir = newDot;
      dotName = ".dridock";
    } else if (await this.fs.isDirectory(oldDot)) {
      dotDir = oldDot;
      dotName = ".claudebox";
    } else {
      dotDir = newDot;
      dotName = ".dridock";
    }
    return { root, dotDir, dotName, configPath: `${dotDir}/config.yml` };
  }
}

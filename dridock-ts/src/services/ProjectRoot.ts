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
 *
 * Two config files, split by whether a value can travel with the repo (#97):
 *
 *   configPath   `config.yml`   MACHINE-LOCAL, gitignored — `id` (the colima
 *                               profile identity, which MUST differ per clone),
 *                               `vm.*` (sized against this host's resources),
 *                               `network.hostname` (an /etc/hosts alias). Also
 *                               the is-this-a-dridock-project sentinel.
 *   projectPath  `project.yml`  PROJECT-LEVEL, tracked/committed — `features:`
 *                               and `plugins:`. The tool bundle and plugin set
 *                               a project needs are the same in every clone, so
 *                               they belong in git. Lazily created: nothing is
 *                               written into a git tree until a project-level
 *                               key is actually set.
 *
 * Before #97 both groups shared `config.yml`, so a project could not state its
 * own feature/plugin set in a way that survived a clone. The legacy location is
 * still READ (and unioned) — see ProjectConfig — and removed in 7.0.0.
 */
export interface ResolvedProject {
  readonly root: string;
  /** Absolute path to the metadata dir (…/.dridock or …/.claudebox). */
  readonly dotDir: string;
  /** Just the basename — for user-facing messages. */
  readonly dotName: ".dridock" | ".claudebox";
  /** Absolute path to `config.yml` inside the dot dir (may not exist yet). */
  readonly configPath: string;
  /**
   * Absolute path to `project.yml` inside the dot dir — the tracked,
   * committed half of the split (#97). Very often absent: it is created
   * only when a project-level key is first set.
   */
  readonly projectPath: string;
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
    return {
      root,
      dotDir,
      dotName,
      configPath: `${dotDir}/config.yml`,
      projectPath: `${dotDir}/project.yml`,
    };
  }
}

import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * A single supervised consult thread — the shape wrapper.sh's
 * cb_consult_home / cb_consult_status / cb_consult_meta_set operate over.
 *
 * On disk (matches bash):
 *   <root>/<id>/meta                 — KEY=VALUE lines (status=…, title=…, updated=…, project=…)
 *   <root>/<id>/001-<author>.md      — first turn (numbered zero-padded)
 *   <root>/<id>/002-<author>.md      — second turn
 *   <root>/<id>/proposed.diff        — optional git-diff attached to a draft
 */
export interface ConsultThread {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly project: string;
  readonly updated: string;
  readonly turnCount: number;
}

/**
 * Reads the on-disk consult tree. Purely read-side for Phase 2; write
 * paths (post / meta-set) land in Phase 3 alongside the migrators.
 */
export class ConsultStore {
  constructor(
    private readonly fs: FileSystem,
    /** The state-dir root — resolved via `paths.stateHome(fs, env, home, "consult")`. */
    private readonly consultHome: string,
  ) {}

  /**
   * List every thread in the consult home, sorted by id.
   * Missing/inaccessible consult home returns `[]` — not an error, matches
   * bash's `if [ ${#_threads[@]} -eq 0 ]; then echo "no consults in $_ch"`.
   */
  async list(): Promise<ConsultThread[]> {
    if (!(await this.fs.isDirectory(this.consultHome))) return [];
    const entries = await this.fs.listDir(this.consultHome);
    const threads: ConsultThread[] = [];
    for (const id of entries.sort()) {
      const dir = `${this.consultHome}/${id}`;
      if (!(await this.fs.isDirectory(dir))) continue;
      threads.push(await this.readThread(id, dir));
    }
    return threads;
  }

  /** Parse the meta file for one thread. Missing keys → empty string. */
  private async readThread(id: string, dir: string): Promise<ConsultThread> {
    const metaText = (await this.fs.readTextOrUndefined(`${dir}/meta`)) ?? "";
    const meta = parseKeyValueLines(metaText);
    const turnCount = await this.countTurns(dir);
    return {
      id,
      status: meta.get("status") ?? "",
      title: meta.get("title") ?? "",
      project: meta.get("project") ?? "",
      updated: meta.get("updated") ?? "",
      turnCount,
    };
  }

  /** Count numbered turn files (`NNN-<author>.md`) — same regex bash uses. */
  private async countTurns(dir: string): Promise<number> {
    try {
      const names = await this.fs.listDir(dir);
      return names.filter((n) => /^\d{3}-.+\.md$/.test(n)).length;
    } catch {
      return 0;
    }
  }
}

/**
 * Parse KEY=VALUE lines into a Map, tolerating trailing whitespace + CRLF.
 * Matches wrapper.sh's `sed -n 's/^status=//p' | tail -1` semantics: on a
 * duplicated key, the last value wins.
 */
export function parseKeyValueLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "") continue;
    out.set(key, value);
  }
  return out;
}

import type { FileSystem } from "../infra/FileSystem.ts";
import type { Clock } from "../infra/Clock.ts";

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
 * Reads AND writes the on-disk consult tree. P4c added setMeta / post /
 * threadDir / show / sig for the approve/revise/reject/post/watch verbs.
 */
export class ConsultStore {
  constructor(
    private readonly fs: FileSystem,
    /** The state-dir root — resolved via `paths.stateHome(fs, env, home, "consult")`. */
    private readonly consultHome: string,
    private readonly clock?: Clock,
  ) {}

  /** Absolute path of one thread's directory. */
  threadDir(id: string): string { return `${this.consultHome}/${id}`; }

  /** Read the meta file KEY=VALUE map, or empty when the file's missing. */
  async meta(id: string): Promise<Map<string, string>> {
    const text = await this.fs.readTextOrUndefined(`${this.threadDir(id)}/meta`);
    return parseKeyValueLines(text ?? "");
  }

  /**
   * setMeta id key value — write or replace KEY in the thread's meta file.
   * Also stamps `updated=<clock>`. Ports cb_consult_meta_set at
   * wrapper.sh:1562. Uses writeTextAtomic to prevent half-writes.
   */
  async setMeta(id: string, key: string, value: string): Promise<void> {
    const dir = this.threadDir(id);
    await this.fs.mkdirRecursive(dir);
    const meta = await this.meta(id);
    meta.set(key, value);
    // Always stamp updated= — ports the `sed -i ... updated=` chain.
    if (this.clock !== undefined) meta.set("updated", this.clock.timestamp());
    else if (!meta.has("updated")) meta.set("updated", "");
    const lines: string[] = [];
    for (const [k, v] of meta) lines.push(`${k}=${v}`);
    await this.fs.writeTextAtomic(`${dir}/meta`, lines.join("\n") + "\n", { mode: 0o644 });
  }

  /**
   * post id author body — append the next numbered turn file
   * `NNN-<author>.md`. Ports cb_consult_post at wrapper.sh:1571.
   */
  async post(id: string, author: string, body: string): Promise<string> {
    const dir = this.threadDir(id);
    await this.fs.mkdirRecursive(dir);
    const existing = (await this.fs.listDir(dir).catch(() => [] as string[]))
      .filter((n) => /^\d{3}-.+\.md$/.test(n));
    const next = String(existing.length + 1).padStart(3, "0");
    const filename = `${next}-${author}.md`;
    await this.fs.writeText(`${dir}/${filename}`, body, { mode: 0o644 });
    return filename;
  }

  /**
   * Copy a diff file into the thread's proposed.diff (bash's `cp` in
   * consult post --diff). Reads src content and writes to dst — filesystem
   * abstraction can't shell out to `cp`.
   */
  async attachDiff(id: string, srcPath: string): Promise<void> {
    const content = await this.fs.readTextOrUndefined(srcPath);
    if (content === undefined) throw new Error(`consult attach diff: source not found: ${srcPath}`);
    await this.fs.writeText(`${this.threadDir(id)}/proposed.diff`, content, { mode: 0o644 });
  }

  /**
   * sig — one line per thread: `id|status|nturns`, sorted. Used by
   * `watch` to diff between polls. Ports cb_consult_sig at
   * wrapper.sh:1581.
   */
  async sig(projectFilter?: string): Promise<readonly string[]> {
    if (!(await this.fs.isDirectory(this.consultHome))) return [];
    const entries = await this.fs.listDir(this.consultHome);
    const out: string[] = [];
    for (const id of entries.sort()) {
      const dir = `${this.consultHome}/${id}`;
      if (!(await this.fs.isDirectory(dir))) continue;
      const meta = await this.meta(id);
      if (projectFilter !== undefined && meta.get("project") !== projectFilter) continue;
      const status = meta.get("status") ?? "";
      const turnCount = ((await this.fs.listDir(dir).catch(() => [] as string[]))
        .filter((n) => /^\d{3}-.+\.md$/.test(n))).length;
      out.push(`${id}|${status}|${turnCount}`);
    }
    return out.sort();
  }

  /**
   * Show one thread — returns the parts a renderer needs.
   */
  async show(id: string): Promise<{ meta: string; turns: Array<{ name: string; body: string }>; diff?: string } | undefined> {
    const dir = this.threadDir(id);
    if (!(await this.fs.isDirectory(dir))) return undefined;
    const meta = (await this.fs.readTextOrUndefined(`${dir}/meta`)) ?? "";
    const entries = (await this.fs.listDir(dir)).filter((n) => /^\d{3}-.+\.md$/.test(n)).sort();
    const turns: Array<{ name: string; body: string }> = [];
    for (const name of entries) {
      const body = (await this.fs.readTextOrUndefined(`${dir}/${name}`)) ?? "";
      turns.push({ name, body });
    }
    const diff = await this.fs.readTextOrUndefined(`${dir}/proposed.diff`);
    return { meta, turns, ...(diff !== undefined ? { diff } : {}) };
  }

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

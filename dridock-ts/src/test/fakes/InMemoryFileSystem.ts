import type { FileSystem } from "../../infra/FileSystem.ts";

/**
 * In-memory FileSystem for tests. No disk, no `mktemp -d`, no
 * `XDG_CONFIG_HOME=` scaffolding. Tests seed it directly:
 *
 *   const fs = new InMemoryFileSystem();
 *   fs.seed("/proj/.dridock/config.yml", "id: abc\nvm:\n  cpu: 4\n");
 *   const info = await new InfoCommand(fs, …).run([], ctx);
 *
 * Deliberately narrow — same surface as the FileSystem interface, plus a
 * `seed` helper and a `.recordedWrites` array for asserting writes happened.
 */
export class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, { content: string; mode?: number }>();
  private readonly directories = new Set<string>();
  readonly recordedWrites: Array<{ path: string; content: string; mode?: number }> = [];

  /** Test-only: pre-populate a file. Marks all its parent dirs as existing. */
  seed(path: string, content: string, opts: { mode?: number } = {}): void {
    this.files.set(path, { content, mode: opts.mode });
    let dir = dirnameOf(path);
    while (dir && dir !== "/" && dir !== ".") {
      this.directories.add(dir);
      dir = dirnameOf(dir);
    }
  }

  /** Test-only: pre-create a directory (with no files in it yet). */
  seedDir(path: string): void {
    this.directories.add(path);
    let dir = dirnameOf(path);
    while (dir && dir !== "/" && dir !== ".") {
      this.directories.add(dir);
      dir = dirnameOf(dir);
    }
  }

  async readText(path: string): Promise<string> {
    const entry = this.files.get(path);
    if (entry === undefined) throw new Error(`InMemoryFileSystem: no such file: ${path}`);
    return entry.content;
  }

  async readTextOrUndefined(path: string): Promise<string | undefined> {
    return this.files.get(path)?.content;
  }

  async writeText(path: string, content: string, opts: { mode?: number } = {}): Promise<void> {
    this.files.set(path, { content, mode: opts.mode });
    this.recordedWrites.push({ path, content, mode: opts.mode });
    // Also mark parent dir as existing
    let dir = dirnameOf(path);
    while (dir && dir !== "/" && dir !== ".") {
      this.directories.add(dir);
      dir = dirnameOf(dir);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.directories.has(path);
  }

  async listDir(path: string): Promise<string[]> {
    if (!this.directories.has(path)) throw new Error(`InMemoryFileSystem: no such directory: ${path}`);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const firstSegment = rest.split("/")[0];
        if (firstSegment !== undefined && firstSegment !== "") names.add(firstSegment);
      }
    }
    for (const dirPath of this.directories) {
      if (dirPath === path) continue;
      if (dirPath.startsWith(prefix)) {
        const rest = dirPath.slice(prefix.length);
        const firstSegment = rest.split("/")[0];
        if (firstSegment !== undefined && firstSegment !== "") names.add(firstSegment);
      }
    }
    return [...names].sort();
  }

  /** Test-only: get the mode of a file (for asserting chmod). */
  modeOf(path: string): number | undefined {
    return this.files.get(path)?.mode;
  }

  /** Test-only: full path listing (for debug printing). */
  allPaths(): string[] {
    return [...this.files.keys(), ...this.directories].sort();
  }

  /* ── mutating primitives (Phase 3) — match RealFileSystem semantics ── */

  async mkdirRecursive(path: string): Promise<void> {
    let dir = path;
    while (dir && dir !== "/" && dir !== ".") {
      this.directories.add(dir);
      dir = dirnameOf(dir);
    }
  }

  async move(src: string, dst: string): Promise<void> {
    // Same "refuse to overwrite" contract as RealFileSystem — never
    // silently clobber; migrators build their split-brain branches on
    // this being loud.
    if (this.files.has(dst) || this.directories.has(dst)) {
      throw new Error(`refuse to overwrite existing destination: ${dst}`);
    }
    if (this.files.has(src)) {
      const entry = this.files.get(src)!;
      this.files.delete(src);
      await this.mkdirRecursive(dirnameOf(dst));
      this.files.set(dst, entry);
      return;
    }
    if (this.directories.has(src)) {
      const srcPrefix = src.endsWith("/") ? src : `${src}/`;
      const dstPrefix = dst.endsWith("/") ? dst : `${dst}/`;
      // Move every descendant file and dir under a new prefix. The mutation
      // is done in two passes so we don't invalidate the map iteration.
      const fileMoves: Array<[string, { content: string; mode?: number }]> = [];
      for (const [p, entry] of this.files) {
        if (p === src || p.startsWith(srcPrefix)) {
          const suffix = p.slice(src.length);
          fileMoves.push([dst + suffix, entry]);
          this.files.delete(p);
        }
      }
      const dirMoves: string[] = [];
      for (const d of this.directories) {
        if (d === src || d.startsWith(srcPrefix)) {
          const suffix = d.slice(src.length);
          dirMoves.push(dst + suffix);
        }
      }
      // Delete old dirs after collecting to avoid Set mutation during iteration
      for (const d of this.directories) {
        if (d === src || d.startsWith(srcPrefix)) this.directories.delete(d);
      }
      await this.mkdirRecursive(dirnameOf(dst));
      for (const [np, entry] of fileMoves) this.files.set(np, entry);
      for (const nd of dirMoves) this.directories.add(nd);
      this.directories.add(dst);
      // Also drop src prefix from directories if it slipped in via dstPrefix logic
      void dstPrefix;
      return;
    }
    throw new Error(`InMemoryFileSystem: no such source: ${src}`);
  }

  async removeFile(path: string): Promise<void> {
    // ENOENT-idempotent, matches RealFileSystem + bash `rm -f`.
    this.files.delete(path);
  }

  async rmDirIfEmpty(path: string): Promise<void> {
    if (!this.directories.has(path)) return; // ENOENT-idempotent
    const prefix = path.endsWith("/") ? path : `${path}/`;
    // ENOTEMPTY-idempotent (matches bash `rmdir 2>/dev/null || true`).
    // The "IfEmpty" in the name says silent-skip on non-empty.
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) return;
    }
    for (const d of this.directories) {
      if (d !== path && d.startsWith(prefix)) return;
    }
    this.directories.delete(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const entry = this.files.get(path);
    if (entry === undefined) throw new Error(`chmod: no such file: ${path}`);
    this.files.set(path, { ...entry, mode });
  }

  async writeTextAtomic(path: string, content: string, opts: { mode?: number } = {}): Promise<void> {
    // No temp/rename semantics in memory — the whole in-memory Map is a
    // single atomic reference. Just record the write.
    await this.writeText(path, content, opts);
  }
}

/** Local `dirname` — avoids importing node:path so this file is trivially portable. */
function dirnameOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return path.slice(0, lastSlash);
}

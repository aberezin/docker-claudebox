import { mkdir, writeFile, readdir, stat, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Production `FileSystem` — Bun.file for reads (fastest), node:fs/promises
 * for writes/stat (Bun.file lacks explicit write-with-mode). No caching, no
 * retry, no error masking; failures throw with the underlying errno.
 */
export class RealFileSystem implements FileSystem {
  async readText(path: string): Promise<string> {
    return await Bun.file(path).text();
  }

  async readTextOrUndefined(path: string): Promise<string | undefined> {
    try {
      return await this.readText(path);
    } catch {
      return undefined;
    }
  }

  async writeText(path: string, content: string, opts: { mode?: number } = {}): Promise<void> {
    // Ensure parent dir exists. `recursive: true` is a no-op when it already does.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    if (opts.mode !== undefined) await chmod(path, opts.mode);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async listDir(path: string): Promise<string[]> {
    return await readdir(path);
  }
}

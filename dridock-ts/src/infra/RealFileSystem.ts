import { mkdir, writeFile, readdir, stat, chmod, rename, unlink, rmdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
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

  async mkdirRecursive(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async move(src: string, dst: string): Promise<void> {
    // Explicit refuse-to-overwrite: fs.rename() would silently replace on
    // POSIX (dst is unlinked as part of the rename). We want a hard "no"
    // instead — the migrators build "leave both, warn" branches on top of
    // this contract, so a silent-clobber would defeat them.
    if (await this.exists(dst)) throw new Error(`refuse to overwrite existing destination: ${dst}`);
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
  }

  async removeFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (e) {
      // ENOENT is intentional-idempotent (matches bash `rm -f`). Everything
      // else (EACCES, EISDIR) surfaces as a real failure.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  async rmDirIfEmpty(path: string): Promise<void> {
    try {
      await rmdir(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT + ENOTEMPTY + EEXIST(macOS) are intentional no-ops
      // (matches bash `rmdir 2>/dev/null || true` — the "IfEmpty" name
      // says silent-skip on non-empty). Anything else (EACCES, etc.)
      // still surfaces so an actual permission bug isn't swallowed.
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }

  async writeTextAtomic(path: string, content: string, opts: { mode?: number } = {}): Promise<void> {
    // Same-directory tempfile → rename over path. POSIX rename within a
    // filesystem is atomic; a reader either sees the old file or the new
    // one, never a half-written one. The tempname includes a random
    // suffix so parallel writes to the same target don't collide.
    await mkdir(dirname(path), { recursive: true });
    const rand = Math.floor(Math.random() * 1e9).toString(36);   // eslint-disable-line no-restricted-globals
    const tmp = `${dirname(path)}/.${basename(path)}.tmp.${process.pid}.${rand}`;
    try {
      await writeFile(tmp, content, "utf8");
      if (opts.mode !== undefined) await chmod(tmp, opts.mode);
      await rename(tmp, path);
    } catch (e) {
      // Best-effort cleanup of the tempfile on failure — don't mask the
      // original error.
      try { await unlink(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
}

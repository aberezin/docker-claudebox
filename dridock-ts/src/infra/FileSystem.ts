/**
 * A narrow file-system interface the domain and services depend on. Real
 * implementation uses Bun.file / fs.promises; test implementation is an
 * in-memory Map. Every service takes `FileSystem` in its constructor so
 * unit tests never touch the real disk — the whole class of `mktemp -d` /
 * `XDG_CONFIG_HOME=` scaffolding wrapper.sh's tests needed goes away.
 *
 * Kept intentionally small: read/write/exists/list. Nothing else added
 * until a service demands it — every method is a mock we'd have to write.
 */
export interface FileSystem {
  /** Returns the file's UTF-8 contents. Throws if it doesn't exist or isn't a file. */
  readText(path: string): Promise<string>;
  /** Convenience: readText but returns undefined instead of throwing. */
  readTextOrUndefined(path: string): Promise<string | undefined>;
  /** Writes UTF-8 content, creating parent dirs if needed. Throws on failure. */
  writeText(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  /** True if the path exists (file OR directory). */
  exists(path: string): Promise<boolean>;
  /** True if the path exists AND is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /** List immediate children of a directory (names only, no recursion). */
  listDir(path: string): Promise<string[]>;

  /* ── mutating primitives added in Phase 3 for migrators + safe-rewrite ── */

  /** `mkdir -p` — creates every missing ancestor. No-op if already present.
   *  Throws only on hard filesystem errors (permission, ENOSPC). */
  mkdirRecursive(path: string): Promise<void>;

  /** Rename or move a path (file OR directory). Cross-device fallback is
   *  the impl's responsibility. Throws if `src` is missing, or if `dst`
   *  already exists — never silently overwrites (that's a whole class of
   *  data loss we don't want to write). */
  move(src: string, dst: string): Promise<void>;

  /** Delete a single file. No-op if it doesn't exist (idempotent — this is
   *  the shape sidecar cleanup wants). Throws on directory (use rmDir). */
  removeFile(path: string): Promise<void>;

  /** Delete a directory if it is empty. No-op on ENOENT AND on ENOTEMPTY —
   *  the "IfEmpty" name is the contract. Matches bash's
   *  `rmdir "$path" 2>/dev/null || true`. Migrators rely on this to leave
   *  a non-empty legacy dir behind (visibly, via the leftover directory)
   *  rather than crash the whole migration. */
  rmDirIfEmpty(path: string): Promise<void>;

  /** Change permission bits on a file (e.g. 0o600 on secrets.env). */
  chmod(path: string, mode: number): Promise<void>;

  /**
   * Atomic write: writes to a sibling tempfile, fsync, rename over `path`.
   * The rename is atomic within the same directory on POSIX, so a reader
   * never observes a half-written file — the whole class of "power cut
   * mid-write leaves an empty config.yml" bug. `mode` sets the final
   * permission bits (defaults to 0o644; migrators pass 0o600 for secrets).
   */
  writeTextAtomic(path: string, content: string, opts?: { mode?: number }): Promise<void>;
}

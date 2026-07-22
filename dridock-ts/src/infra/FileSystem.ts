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
}

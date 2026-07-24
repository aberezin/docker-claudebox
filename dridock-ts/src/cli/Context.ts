import type { FileSystem } from "../infra/FileSystem.ts";
import type { EnvResolver } from "../domain/EnvResolver.ts";

/**
 * The per-invocation context — everything a command might touch, injected
 * at the composition root. Commands take this in their `.run(argv, ctx)`
 * signature. Real `main.ts` builds a Context wired to production adapters;
 * tests build one wired to the in-memory fakes.
 *
 * Kept intentionally narrow: file system, env, project root, and IO
 * streams. Docker / Colima come in Phase 3 (they're not needed for the
 * first read-only verbs). Adding a dependency is one more field here.
 */
export interface Context {
  readonly fs: FileSystem;
  readonly env: EnvResolver;
  /** Absolute path to the current working directory (project root). */
  readonly cwd: string;
  /** `HOME` — for resolving `~/.claude/*` sidecars, watermark files, etc. */
  readonly home: string;
  /** Whatever the user typed as the CLI binary name (dridock, claudebox, etc.).
   *  Used in help/error text so `dridock` vs the legacy `claudebox` symlink
   *  both print references matching what the user actually typed — same shape
   *  as wrapper.sh's $CB_SELF (added in 3.2.3). */
  readonly binName: string;
  /** stdout writer — commands write user-facing output here. */
  readonly stdout: TextWriter;
  /** stderr writer — commands write warnings + errors here. */
  readonly stderr: TextWriter;
}

/** A minimal write-only stream interface — decouples from `Bun.stdout` /
 *  Node streams so tests can capture output as strings. */
export interface TextWriter {
  write(chunk: string): void;
}

/** Tests use this to capture output. Production wires `Bun.stdout` / `Bun.stderr`. */
export class StringWriter implements TextWriter {
  private readonly chunks: string[] = [];
  write(chunk: string): void { this.chunks.push(chunk); }
  /** All chunks concatenated. Alias `toString` kept for `${writer}` interpolation. */
  text(): string { return this.chunks.join(""); }
  toString(): string { return this.chunks.join(""); }
  reset(): void { this.chunks.length = 0; }
}

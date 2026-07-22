import type { FileSystem } from "../infra/FileSystem.ts";

/**
 * Reads a project's `.dridock/config.yml` (or legacy `.claudebox/config.yml`)
 * and answers questions about its declared features. Ports the read-side
 * of wrapper.sh's `cb_project_features` — the awk that tolerates both YAML
 * flow style and block style, keeps identifier chars only, and dedupes.
 *
 * Write-side (features:enable/disable → cb_features_write) lives in Phase 3
 * — that path mutates config.yml and needs the safe-rewrite scaffolding
 * (tempfile + rename) common to every migrator.
 */
export class ProjectConfig {
  constructor(private readonly fs: FileSystem) {}

  /**
   * Enabled features from `configPath`.
   *   - missing/unreadable config -> `[]` (matches bash's `[ -f "$cfg" ] || return 0`)
   *   - flow style: `features: [typescript, python]`
   *   - block style:
   *       features:
   *         - typescript
   *         - python
   *   - legacy `profiles:` accepted (2.x compat, same awk branch)
   * Returned in original order, deduplicated. Names are validated as `[A-Za-z0-9_-]+`
   * (matches the bash gsub); anything else is silently dropped — same as bash.
   */
  async features(configPath: string): Promise<string[]> {
    const text = await this.fs.readTextOrUndefined(configPath);
    if (text === undefined) return [];
    return parseFeatures(text);
  }
}

/**
 * Extracts feature names from the config-file text. Kept as a top-level
 * function so the parser is unit-testable without an FS at all.
 * Mirrors the awk in wrapper.sh:1291-1301 — the only YAML we need to
 * understand is one `features:` (or legacy `profiles:`) key + its value.
 */
export function parseFeatures(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const result: string[] = [];
  let inBlock = false;

  const emit = (raw: string): void => {
    const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "");
    if (cleaned === "" || seen.has(cleaned)) return;
    seen.add(cleaned);
    result.push(cleaned);
  };

  for (const rawLine of lines) {
    // Flow form: `features: [a, b, c]` on one line.
    const flow = rawLine.match(/^\s*(?:features|profiles):\s*\[([^\]]*)\]/);
    if (flow) {
      for (const name of flow[1]!.split(",")) emit(name.trim());
      inBlock = false;
      continue;
    }

    // Block header: `features:` (or `profiles:`) with nothing (or a comment) after.
    if (/^\s*(?:features|profiles):\s*(?:#.*)?$/.test(rawLine)) {
      inBlock = true;
      continue;
    }

    if (inBlock) {
      // Block item: `  - name  # comment`
      const item = rawLine.match(/^\s*-\s*([^#]*)(?:#.*)?$/);
      if (item) { emit(item[1]!.trim()); continue; }
      // Blank / comment line inside a block — stay in block.
      if (/^\s*(?:#.*)?$/.test(rawLine)) continue;
      // Anything else exits the block.
      inBlock = false;
    }
  }
  return result;
}

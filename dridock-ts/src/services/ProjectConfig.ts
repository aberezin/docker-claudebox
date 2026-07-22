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
   * The project's stable id — the value of the `id:` key in config.yml.
   * Returns undefined if config.yml is missing, id: is missing, or id is
   * the sentinel "auto" (which means "unbootstrapped, generate on first
   * `dridock start`"). Ports the read-only half of cb_project_id_ro.
   *
   * The read-only variant intentionally does NOT trigger a bootstrap
   * (cb_project_id / cb_init_project_config) — that's a write path.
   */
  async projectId(configPath: string): Promise<string | undefined> {
    const text = await this.fs.readTextOrUndefined(configPath);
    if (text === undefined) return undefined;
    const id = parseTopLevelString(text, "id");
    if (id === undefined || id === "auto") return undefined;
    return id;
  }

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
 * Grab the value of a top-level KEY: VALUE line from the config-file
 * text. Not nested — bash uses `_cb_yaml_get` which is also flat-only
 * for the ids/hostnames dridock cares about. Value is trimmed and any
 * matching quote pair stripped; comments after the value dropped.
 * Missing key → undefined. Empty value → undefined.
 */
export function parseTopLevelString(text: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(.*)$`);
  for (const rawLine of text.split(/\r?\n/)) {
    // Skip indented (nested-child) lines; only top-level keys match. A key
    // is "top-level" iff the line starts at column 0 (no leading whitespace).
    if (/^\s/.test(rawLine)) continue;
    const m = rawLine.match(re);
    if (!m) continue;
    let v = m[1]!.replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v === "" ? undefined : v;
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

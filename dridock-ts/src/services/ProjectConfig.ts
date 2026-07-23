import type { FileSystem } from "../infra/FileSystem.ts";
import { cbNum } from "../domain/units.ts";

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
   * Rewrite the `features:` block in config.yml to `names` (flow-style),
   * stripping any existing `features:`/`profiles:` (both flow and block
   * form). Empty `names` removes the block entirely. Ports
   * cb_features_write at wrapper.sh:1346 — the safe-rewrite scaffolding
   * (writeTextAtomic) means a power-cut mid-write can never leave a
   * truncated config.yml (the class fixed for `cb_features_write` in
   * 3.3.6 Tier-1 #5).
   */
  async setFeatures(configPath: string, names: readonly string[]): Promise<void> {
    const text = await this.fs.readTextOrUndefined(configPath);
    if (text === undefined) {
      throw new Error(`setFeatures: no config.yml at ${configPath} — run 'dridock start' first to initialize`);
    }
    const stripped = stripFeaturesBlock(text);
    // Trim trailing blank lines so the appended features: block sits
    // cleanly at the end (matches the bash `awk 'NF{p=1}...'` trim step).
    const trimmed = stripped.replace(/\n+$/, "");
    const rebuilt = names.length === 0
      ? trimmed + "\n"
      : `${trimmed}\n\nfeatures: [${names.join(", ")}]\n`;
    await this.fs.writeTextAtomic(configPath, rebuilt);
  }

  /**
   * The VM sizing for this project, with per-level fallbacks:
   *   1. project's own config.yml under `vm:` (cpu/memory/disk)
   *   2. machine config `vm.default_*` (via `MachineConfig.vmDefault(field)`)
   *   3. baked default (cpu=4, memory=8GiB, disk=60GiB)
   * Bash values are numeric-strippable (`cb_num` reduces "8GiB" → 8) —
   * we return the same integer shape (GiB for memory/disk).
   */
  async vmSize(configPath: string, field: "cpu" | "memory" | "disk", machineDefault?: string): Promise<number> {
    const text = await this.fs.readTextOrUndefined(configPath);
    const raw = text !== undefined ? parseNestedYaml(text, "vm", field) : undefined;
    const value = raw ?? machineDefault ?? bakedVmDefault(field);
    return cbNumOr0(value);
  }

  /**
   * `network.hostname` from config.yml — for `dridock net`. undefined
   * when unset.
   */
  async networkHostname(configPath: string): Promise<string | undefined> {
    const text = await this.fs.readTextOrUndefined(configPath);
    if (text === undefined) return undefined;
    return parseNestedYaml(text, "network", "hostname");
  }

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
 * Extract a nested `parent.child` YAML value from a 2-level document.
 * Matches `_cb_yaml_get` at wrapper.sh:156 — indent-anchored (top-level
 * keys have no leading whitespace; block children are indented). Returns
 * undefined for missing/blank values. Not general YAML — mirrors bash's
 * awk-based flat/nested reader.
 */
export function parseNestedYaml(text: string, parent: string, child: string): string | undefined {
  let inParent = false;
  const parentRe = new RegExp(`^${escapeRegex(parent)}\\s*:`);
  const childRe = new RegExp(`^\\s+${escapeRegex(child)}\\s*:\\s*(.*)$`);
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "" || /^\s*#/.test(rawLine)) continue;
    if (parentRe.test(rawLine)) { inParent = true; continue; }
    if (!/^\s/.test(rawLine)) { inParent = false; continue; }  // any non-indented line ends the parent
    if (!inParent) continue;
    const m = rawLine.match(childRe);
    if (!m) continue;
    let v = m[1]!.replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v === "" ? undefined : v;
  }
  return undefined;
}

/**
 * Bash `cb_num` — strip suffix → integer part. Reuses domain/units.ts's
 * cbNum (which throws on unparseable) but wraps in a 0-default because
 * bash's `${cb_num():-0}` pattern silently degrades unparseable to 0.
 */
function cbNumOr0(s: string): number {
  try { return Math.floor(cbNum(s)); }
  catch { return 0; }
}

/** Bash `cb_baked_default vm.<field>` (wrapper.sh:143-146). */
function bakedVmDefault(field: "cpu" | "memory" | "disk"): string {
  switch (field) {
    case "cpu":    return "4";
    case "memory": return "8GiB";
    case "disk":   return "100GiB";
  }
}

/**
 * Strip `features:` and `profiles:` blocks (flow OR block form) from a
 * YAML doc. Ports the awk at wrapper.sh:1352-1359 exactly:
 *   - `features: [a,b,c]` on one line → drop that line
 *   - `features:` (or with trailing comment) → drop that line AND every
 *     following `  - x` / blank / `  # comment` line until a
 *     non-indented, non-comment line ends the block
 */
export function stripFeaturesBlock(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:features|profiles):\s*\[/.test(line)) { skipping = false; continue; }
    if (/^\s*(?:features|profiles):\s*(?:#.*)?$/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^\s*-\s*/.test(line)) continue;   // block item
      if (/^\s*(?:#.*)?$/.test(line)) continue;   // comment/blank inside block
      skipping = false;
      // fall through — this line belongs to the next YAML key
    }
    out.push(line);
  }
  return out.join("\n");
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

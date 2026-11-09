import type { FileSystem } from "../infra/FileSystem.ts";
import { cbNum } from "../domain/units.ts";

/**
 * Reads a project's dridock config and answers questions about it.
 *
 * TWO FILES since #97, split by whether a value can travel with the repo:
 *
 *   `config.yml`   machine-local, **gitignored** — `id`, `vm.*`,
 *                  `network.hostname`. Also the project sentinel.
 *   `project.yml`  project-level, **tracked** — `features:`, `plugins:`.
 *
 * Before #97 both lived in `config.yml`, so a project could not declare its
 * own feature/plugin set in a way that survived a clone — `profiles:` had
 * that defect since 3.x and #96's `plugins:` inherited it.
 *
 * READ resolution is a **union**, `project.yml` first (`featuresResolved` /
 * `pluginsResolved`). Union rather than override because the installs are
 * already additive and marker-guarded (`.profile-<name>`, `.plugin-<slug>`):
 * "the project needs these, and I also want these locally" composes. The
 * legacy location keeps working — never silently discarded — and the resolver
 * hands back a `legacy` list so the caller can print the one-line nudge.
 * Removed in 7.0.0 (roadmap row + tests/test_deprecation_deadlines.sh).
 *
 * WRITE goes to `project.yml`, lazily created (`setProjectList`) — nothing
 * appears in someone's git tree until they actually set a project-level key.
 * `setFeatures` still writes `config.yml` and is retained for exactly one
 * caller: `features disable`, which must be able to remove a name from the
 * legacy location or the disable would silently no-op.
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
    await this.fs.writeTextAtomic(configPath, rewriteListBlock(text, "features", names));
  }

  /**
   * Write `key` into `project.yml`, **creating the file** if absent (#97).
   *
   * Lazy creation is the point: bootstrap deliberately does not scaffold
   * `project.yml`, so nothing lands in a git tree unasked. The file is born
   * here, the first time someone sets a project-level key, carrying a header
   * that explains what belongs in it vs `config.yml` — the file IS the
   * documentation, which is why there is no `project.sample.yml` to drift.
   *
   * Any OTHER key already in the file survives: `rewriteListBlock` strips
   * only the target key's block (flow or block form) and re-appends it, so
   * `plugins:` is untouched when `features:` is rewritten, comments and all.
   * Empty `names` removes the block but keeps the file — an emptied
   * `features:` is not a reason to delete someone's committed config.
   */
  async setProjectList(
    projectPath: string,
    key: ListKey,
    names: readonly string[],
  ): Promise<void> {
    const existing = await this.fs.readTextOrUndefined(projectPath);
    const base = existing ?? PROJECT_YML_HEADER;
    await this.fs.writeTextAtomic(projectPath, rewriteListBlock(base, key, names));
  }

  /**
   * Rewrite `key` in an EXISTING file, never creating it.
   *
   * The counterpart to `setProjectList`, for editing the deprecated
   * `config.yml` location — used only by the `disable`/`remove` paths, which
   * must be able to drop a name from wherever it actually lives. Reads are a
   * union (#97), so removing from just one file while reporting success is
   * the silent-no-op class.
   *
   * Throws rather than creating: a missing file here means the caller's
   * precondition was wrong (it had just read entries out of it), and inventing
   * a `config.yml` would scaffold a project sentinel as a side effect of a
   * removal.
   */
  async setExistingList(path: string, key: ListKey, names: readonly string[]): Promise<void> {
    const text = await this.fs.readTextOrUndefined(path);
    if (text === undefined) {
      throw new Error(`setExistingList: no file at ${path}`);
    }
    await this.fs.writeTextAtomic(path, rewriteListBlock(text, key, names));
  }

  /**
   * The effective `features:` for this project — `project.yml` ∪ `config.yml`.
   * See the class doc for why this is a union and not an override.
   */
  async featuresResolved(configPath: string, projectPath: string): Promise<ResolvedProjectList> {
    return unionLists(
      parseFeatures((await this.fs.readTextOrUndefined(projectPath)) ?? ""),
      parseFeatures((await this.fs.readTextOrUndefined(configPath)) ?? ""),
    );
  }

  /** The effective `plugins:` for this project — `project.yml` ∪ `config.yml`. */
  async pluginsResolved(configPath: string, projectPath: string): Promise<ResolvedProjectList> {
    return unionLists(
      parsePlugins((await this.fs.readTextOrUndefined(projectPath)) ?? ""),
      parsePlugins((await this.fs.readTextOrUndefined(configPath)) ?? ""),
    );
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

  /**
   * Enabled Claude Code **plugins** from `configPath` (#96).
   *
   * Same flow/block shape as `features(...)`, different key and different
   * character class: a plugin entry is `name@owner/repo` (full form —
   * `owner/repo` is BOTH what `claude plugin marketplace add` takes and
   * the source from which the entrypoint derives the marketplace short
   * name for `claude plugin install`). The sanitizer allows `@` `/` `.`
   * on top of what features allows; shape filter rejects bare names
   * (no `@`) and short-form `name@marketplace` (no `/`).
   *
   *   plugins: [commit-commands@anthropics/claude-plugins-official, superpowers@aberezin/superpowers]
   *
   *   plugins:
   *     - commit-commands@anthropics/claude-plugins-official
   *     - superpowers@aberezin/superpowers
   *
   * Missing config / unreadable → `[]` (matches `features(...)` and the
   * bash `[ -f "$cfg" ] || return 0` pattern). Order is preserved,
   * duplicates deduped, malformed entries silently dropped — same
   * discipline as features. There is no legacy key fallback here (the
   * `plugins:` idea didn't exist before 3.x).
   */
  async plugins(configPath: string): Promise<string[]> {
    const text = await this.fs.readTextOrUndefined(configPath);
    if (text === undefined) return [];
    return parsePlugins(text);
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
    if (/^\s/.test(rawLine)) continue;
    const m = rawLine.match(re);
    if (!m) continue;
    let v = m[1]!.trim();
    // Bash-parity comment stripping (see parseNestedYaml for the same rule).
    if (v.startsWith("#")) v = "";
    else v = v.replace(/\s+#.*$/, "").trim();
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
    let v = m[1]!.trim();
    // Bash `_cb_yaml_get` (wrapper.sh:167): if the value STARTS with `#`
    // the whole line was just a comment on a blank-value key — treat as
    // empty. Otherwise strip an inline ` #comment` suffix (space-hash).
    // Arfy #38 P4c B1 caught the "hostname reads the inline comment
    // when value is blank" bug here — the old `\s+#.*$` regex required
    // whitespace-before-hash, which m[1] no longer has because the
    // parent `:\s*` consumed it.
    if (v.startsWith("#")) v = "";
    else v = v.replace(/\s+#.*$/, "").trim();
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
  return stripListBlock(text, "features");
}

/**
 * The set of YAML key spellings that address one logical list. `features`
 * carries its legacy 2.x alias `profiles`; `plugins` (#96) has none — the
 * mechanism did not exist before 3.x, so there is nothing to be compatible
 * with.
 */
const LIST_KEY_ALIASES: Readonly<Record<ListKey, readonly string[]>> = {
  features: ["features", "profiles"],
  plugins: ["plugins"],
};

export type ListKey = "features" | "plugins";

/**
 * Drop `key`'s block from `text`, in either YAML form — flow (`key: [a, b]`)
 * or block (`key:` + `  - a` lines). Everything else, comments included,
 * survives verbatim: this is what lets `project.yml` hold BOTH `features:`
 * and `plugins:` and have one rewritten without disturbing the other.
 *
 * Generalized from the old features-only version for #97. The skipping state
 * machine is unchanged — a non-item, non-comment line ends the block and
 * falls through, so a following key is never eaten.
 */
export function stripListBlock(text: string, key: ListKey): string {
  const alt = LIST_KEY_ALIASES[key].join("|");
  const flowRe = new RegExp(`^\\s*(?:${alt}):\\s*\\[`);
  const blockRe = new RegExp(`^\\s*(?:${alt}):\\s*(?:#.*)?$`);
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (flowRe.test(line)) { skipping = false; continue; }
    if (blockRe.test(line)) { skipping = true; continue; }
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
 * `text` with `key` rewritten to `names` in flow style, appended at the end.
 * Empty `names` removes the block entirely (and appends nothing).
 *
 * writeTextAtomic at the call sites means a power-cut mid-write can never
 * leave a truncated config (the class fixed for `cb_features_write` in
 * 3.3.6 Tier-1 #5).
 */
export function rewriteListBlock(text: string, key: ListKey, names: readonly string[]): string {
  // Trim trailing blank lines so the appended block sits cleanly at the end
  // (matches the bash `awk 'NF{p=1}...'` trim step).
  const trimmed = stripListBlock(text, key).replace(/\n+$/, "");
  return names.length === 0
    ? trimmed + "\n"
    : `${trimmed}\n\n${key}: [${names.join(", ")}]\n`;
}

/**
 * One logical list resolved across the two config files (#97).
 */
export interface ResolvedProjectList {
  /**
   * The effective list — `project.yml` entries in order, then any
   * `config.yml` entry not already present.
   */
  readonly values: string[];
  /**
   * Entries found in the DEPRECATED location (`config.yml`). Non-empty means
   * the caller owes the user a one-line stderr nudge: the entries still work
   * (never silently discarded) but they cannot travel with a clone, which is
   * the whole point of the split. Removed in 7.0.0.
   */
  readonly legacy: string[];
}

/** project.yml ∪ config.yml, project first, deduped, order preserved. */
export function unionLists(fromProject: readonly string[], fromConfig: readonly string[]): ResolvedProjectList {
  const seen = new Set<string>(fromProject);
  const values = [...fromProject];
  for (const v of fromConfig) {
    if (seen.has(v)) continue;
    seen.add(v);
    values.push(v);
  }
  return { values, legacy: [...fromConfig] };
}

/**
 * The one-line nudge a caller prints when project-level keys are still in the
 * gitignored `config.yml` (#97). Shared by `start`, `features` and `plugins`
 * so the wording cannot drift between them.
 *
 * Deliberately NOT a warning-and-ignore: the entries are honored. The only
 * thing wrong with them is their location, and the cost of that location is
 * exactly what the sentence states.
 */
export function legacyLocationNotice(
  key: ListKey,
  legacy: readonly string[],
  dotName: string,
): string {
  return `ℹ ${key}: in ${dotName}/config.yml (${legacy.join(", ")}) — still applied, but `
    + `config.yml is gitignored so it can't travel with a clone. Move it to `
    + `${dotName}/project.yml (tracked). The config.yml location is removed in 7.0.0.\n`;
}

/**
 * The header a lazily-created `project.yml` is born with. The file is tracked,
 * so this comment block is the primary documentation of the split that a
 * reader will actually encounter — there is deliberately no
 * `project.sample.yml` to fall out of date next to it.
 */
export const PROJECT_YML_HEADER = `# .dridock/project.yml — PROJECT-level dridock config. COMMIT THIS FILE.
#
# Everything here is a property of the project itself, identical in every
# clone, so it belongs in git:
#
#   features: [typescript, python]                # tool bundles  -> 'dridock features'
#   plugins:  [superpowers@aberezin/superpowers]  # Claude Code plugins -> 'dridock plugins'
#
# Machine-local settings live in the gitignored .dridock/config.yml instead
# (project id, VM cpu/memory/disk, network hostname) — those must differ per
# clone and per host.
#
# Docs: docs/design/project-config-split.md
`;

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

/**
 * Extract plugin names from the config-file text (#96). Shape mirrors
 * `parseFeatures` with two deltas:
 *
 *   1. Key is `plugins:` only — no legacy alias (the mechanism didn't
 *      exist before this).
 *   2. Sanitizer allows `@` `/` `.` on top of the features alphabet, so
 *      `name@owner/marketplace` and `anthropics/claude-plugins-official`
 *      survive. Anything outside `[A-Za-z0-9_@/.-]` is stripped. An
 *      entry without `@<marketplace>` is dropped — `claude plugin
 *      install` fails on bare names, and silent acceptance would echo
 *      the bash `cb-report-bug` lesson about never-silently-discarding
 *      user input.
 */
/**
 * The legal shape of a `plugins:` entry: `name@owner/repo`, each segment
 * restricted to `[A-Za-z0-9._-]` — the real char class for GitHub owner/repo
 * and plugin names.
 *
 * Exported so the `dridock plugins add` validator and this parser are the
 * SAME check. A CLI validator that accepted something the parser then
 * silently dropped would be the never-silently-discard class with extra
 * steps: the user gets a success message and no plugin.
 *
 * The tight class also rejects by construction the quote/semicolon/glob
 * characters that let the original permissive regex (`^[^@]+@[^/]+/[^@]+$`)
 * carry `x@a/b\';touch /tmp/INJECTED;\'` through to the entrypoint's
 * `bash -c` — Arfy's #96 finding. `entrypoint.sh`'s `[[ =~ ]]` re-validates
 * the same class downstream; keep the two in sync.
 *
 * Note there is no version/tag component: `marketplace add owner/repo` tracks
 * the marketplace's HEAD, so a plugin set cannot be pinned. A second `@`
 * would not even parse. If pinning is wanted that is a syntax change, not a
 * config change.
 */
export const PLUGIN_SPEC_REGEX = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function parsePlugins(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const result: string[] = [];
  let inBlock = false;

  const emit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === "" || seen.has(trimmed)) return;
    // Shape: `<name>@<owner>/<repo>` with each segment restricted to the
    // actual legal char class for GitHub owner/repo and plugin names:
    // `[A-Za-z0-9._-]`. Rejects by construction: single quotes, semicolons,
    // spaces, `$`, backticks, `*`/`?` globs — anything that would let a
    // hostile `plugins:` entry escape the entrypoint's `bash -c` single-
    // quote context and execute as the claudebot user at entrypoint time.
    // Arfy caught the original permissive regex (`^[^@]+@[^/]+\/[^@]+$`)
    // allowing `x@a/b';touch /tmp/INJECTED;'` during #96 review — the fix
    // is the char class in BOTH layers (TS here, bash `[[ =~ ]]` in
    // entrypoint), not escaping.
    if (!PLUGIN_SPEC_REGEX.test(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };

  for (const rawLine of lines) {
    const flow = rawLine.match(/^\s*plugins:\s*\[([^\]]*)\]/);
    if (flow) {
      for (const name of flow[1]!.split(",")) emit(name.trim());
      inBlock = false;
      continue;
    }
    if (/^\s*plugins:\s*(?:#.*)?$/.test(rawLine)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const item = rawLine.match(/^\s*-\s*([^#]*)(?:#.*)?$/);
      if (item) { emit(item[1]!.trim()); continue; }
      if (/^\s*(?:#.*)?$/.test(rawLine)) continue;
      inBlock = false;
    }
  }
  return result;
}

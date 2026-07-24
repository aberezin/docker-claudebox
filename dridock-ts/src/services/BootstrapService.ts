import type { FileSystem } from "../infra/FileSystem.ts";
import type { HostCommandRunner } from "../infra/HostCommandRunner.ts";
import type { MachineConfig } from "./MachineConfig.ts";
import { parseTopLevelString } from "./ProjectConfig.ts";
import { scanOrphans, formatMintWarning } from "./OrphanSessionScanner.ts";
import { cbNum } from "../domain/units.ts";

/**
 * `dridock bootstrap` — the scaffolding service. Ports the essential shape
 * of cb_bootstrap at wrapper.sh:1877 (which itself composes cb_write_brief,
 * cb_init_project_config, cb_write_readme, cb_write_sample).
 *
 * Not a Command yet — the BootstrapCommand wraps this. Kept as a service
 * so the flag-parsing logic in the command stays small.
 */
export interface BootstrapOptions {
  readonly root: string;
  readonly flavor: "greenfield" | "adopt" | "workspace";
  readonly mode: "full" | "brief-only";
  readonly force: boolean;
  readonly intent: string;
}

export interface BootstrapDeps {
  readonly fs: FileSystem;
  readonly host: HostCommandRunner;
  readonly machine: MachineConfig;
  /** HOME — needed by the orphan-session scanner to resolve `<xdg>/projects/*`
   *  when there's no explicit XDG_CONFIG_HOME (#42 facet 2). */
  readonly home: string;
  /** Where the orphan warning + config-preserved notice goes. Stderr in the
   *  Command wiring; captured in tests. Separate from onNotice (stdout) so
   *  warnings can't be swallowed by `dridock bootstrap > /dev/null`. */
  readonly onWarn?: (message: string) => void;
  readonly onNotice: (message: string) => void;
}

export type BootstrapOutcome =
  | { readonly kind: "brief-exists" }
  | { readonly kind: "done"; readonly flavor: BootstrapOptions["flavor"]; readonly id: string };

/** Ports cb_gen_id — 8 lowercase-hex chars. */
export function generateProjectId(rand: (n: number) => number = Math.random): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 8; i++) s += hex[Math.floor(rand(16) * 16)];
  return s;
}

export class BootstrapService {
  constructor(private readonly deps: BootstrapDeps, private readonly idGen: () => string = generateProjectId) {}

  async run(opts: BootstrapOptions): Promise<BootstrapOutcome> {
    const briefPath = `${opts.root}/.dridock/BRIEF.md`;
    if ((await this.deps.fs.exists(briefPath)) && !opts.force) {
      return { kind: "brief-exists" };
    }
    const dotDir = `${opts.root}/.dridock`;
    await this.deps.fs.mkdirRecursive(dotDir);

    if (opts.mode === "full") {
      switch (opts.flavor) {
        case "adopt": /* skip greenfield scaffolding — existing repo */ break;
        case "workspace":
          if (!(await this.deps.fs.isDirectory(`${opts.root}/.git`))) {
            // `git init` — we intentionally don't shell out here; the
            // caller supplies the runner in BootstrapCommand for the
            // wider cloning paths.
            await this.deps.host.runCapture(`git -C ${shellEscape(opts.root)} init -q`);
            this.deps.onNotice(`  ✓ git init (orchestration parent)\n`);
          }
          await this.writeReadmeIfMissing(opts.root);
          break;
        default:
          await this.deps.host.runCapture(`git -C ${shellEscape(opts.root)} init -q`);
          this.deps.onNotice(`  ✓ git init\n`);
          await this.writeReadmeIfMissing(opts.root);
          await this.deps.fs.mkdirRecursive(`${opts.root}/workloads`);
          await this.deps.fs.writeText(`${opts.root}/workloads/.gitkeep`, "");
          break;
      }
    }

    // BRIEF.md — always written
    await this.writeBrief(briefPath, opts);
    this.deps.onNotice(`  ✓ .dridock/BRIEF.md\n`);

    // config.yml — preserve existing id if present (#42 facet 1) OR mint +
    // write; on the mint path, warn about session dirs a fresh id would
    // orphan (#42 facet 2). Bash-parity with cb_init_project_config's
    // cb_project_id gate at wrapper.sh:504/523 that this port had lost.
    const cfg = await this.writeInitialConfig(opts.root);
    this.deps.onNotice(cfg.preserved
      ? `  ✓ .dridock/config.yml (preserved existing id ${cfg.id})\n`
      : `  ✓ .dridock/config.yml (gitignored)\n`);
    const id = cfg.id;

    // gitignore always ensured
    await this.ensureGitignore(opts.root);

    return { kind: "done", flavor: opts.flavor, id };
  }

  /**
   * cb_init_project_config equivalent — either PRESERVES an existing real
   * `id:` (bash-parity, wrapper.sh:504+523 gate), or mints a fresh id and
   * writes `.dridock/config.yml`. Never clobbers an existing id.
   *
   * #42 regression: the pre-fix version always minted + always overwrote,
   * silently orphaning the id-keyed `~/.claude` mount on any bootstrap
   * re-run (lineage: #17, #30, #31, #32).
   */
  private async writeInitialConfig(root: string): Promise<{ id: string; preserved: boolean }> {
    const configPath = `${root}/.dridock/config.yml`;
    const existing = await this.deps.fs.readTextOrUndefined(configPath);
    const existingId = existing !== undefined ? parseTopLevelString(existing, "id") : undefined;
    // Preserve any REAL existing id — anything that isn't the sentinel
    // "auto" or empty. Same shape as ProjectConfig.projectId's read-side.
    if (existingId !== undefined && existingId !== "auto" && existingId !== "") {
      return { id: existingId, preserved: true };
    }
    // About to mint — check whether a fresh id would orphan sibling
    // session dirs under a different existing id (#42 facet 2).
    await this.warnIfSessionsWillBeOrphaned(root);
    const id = this.idGen();
    const cpu = cbNumOr(await this.deps.machine.machineDefault("vm.default_cpu"), 4);
    const memory = await this.deps.machine.machineDefault("vm.default_memory") ?? "8GiB";
    const disk = await this.deps.machine.machineDefault("vm.default_disk") ?? "60GiB";
    const content = `# .dridock/config.yml — generated by the wrapper; edit to taste. Gitignored.
id: ${id}
vm:
  cpu: ${cpu}
  memory: ${memory}
  disk: ${disk}
  autostop: false         # stop the VM when the harness container exits
network:
  hostname:               # optional: set e.g. "myproj" for a friendly http://myproj:<port> — 'dridock net' also sets this
# features: []            # opt-in tool bundles, e.g. [typescript, python] — list them: 'dridock features'
`;
    await this.deps.fs.writeTextAtomic(configPath, content, { mode: 0o644 });
    return { id, preserved: false };
  }

  /**
   * #42 facet 2 — pre-mint half of the defense-in-depth check.
   *
   * Delegates to the shared [[OrphanSessionScanner]] so `BootstrapService`
   * (this), `StartCommand`, and `CronModeCommand` all use the same logic
   * and stay in lockstep. Only fires on the mint path (writeInitialConfig
   * calls this immediately before `this.idGen()`); preserve-id path
   * skips it — no mint = no orphan risk.
   */
  private async warnIfSessionsWillBeOrphaned(root: string): Promise<void> {
    const orphans = await scanOrphans(
      { fs: this.deps.fs, env: process.env, home: this.deps.home },
      root,
      undefined,   // no own id yet — we're about to mint
    );
    if (orphans.length === 0) return;
    const warn = this.deps.onWarn ?? this.deps.onNotice;
    for (const line of formatMintWarning(orphans)) warn(line);
  }

  /**
   * Ensure `.gitignore` contains the machine-local dot-dir lines. Ports
   * cb_ensure_gitignore at wrapper.sh:422 — safe to run repeatedly.
   */
  private async ensureGitignore(root: string): Promise<void> {
    if (!(await this.deps.fs.isDirectory(`${root}/.git`))) return;   // matches bash guard
    const gitignorePath = `${root}/.gitignore`;
    const existing = (await this.deps.fs.readTextOrUndefined(gitignorePath)) ?? "";
    const wanted = [
      "/.dridock/config.yml",
      "/.dridock/secrets.env",
      "/.claudebox/config.yml",
      "/.claudebox/secrets.env",
    ];
    let next = existing;
    for (const line of wanted) {
      if (!next.split("\n").includes(line)) {
        next = (next.length > 0 && !next.endsWith("\n") ? next + "\n" : next) + line + "\n";
      }
    }
    if (next !== existing) await this.deps.fs.writeTextAtomic(gitignorePath, next);
  }

  private async writeReadmeIfMissing(root: string): Promise<void> {
    const path = `${root}/README.md`;
    if (await this.deps.fs.exists(path)) return;
    const name = root.split("/").pop() ?? "project";
    await this.deps.fs.writeText(path, `# ${name}\n\nBootstrapped by dridock. See \`.dridock/BRIEF.md\` for the mission brief.\n`);
    this.deps.onNotice(`  ✓ README.md\n`);
  }

  private async writeBrief(briefPath: string, opts: BootstrapOptions): Promise<void> {
    const flavorLine = {
      "adopt": "**Flavor:** adopt (existing repo)",
      "workspace": "**Flavor:** multi-repo orchestration parent",
      "greenfield": "**Flavor:** greenfield",
    }[opts.flavor];
    const intent = opts.intent.trim() === "" ? "_(no intent provided — edit this file to describe what you're building)_" : opts.intent.trim();
    const content = `# Mission brief

${flavorLine}

## Intent

${intent}

## Progress / handoff log

- _(add entries as the project evolves)_
`;
    await this.deps.fs.writeTextAtomic(briefPath, content, { mode: 0o644 });
  }
}

/** Escape a path for safe use inside a shell single-quoted argument.
 *  Simple: wrap in single quotes and escape any embedded single quotes. */
function shellEscape(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function cbNumOr(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  try { return Math.floor(cbNum(s)); } catch { return fallback; }
}

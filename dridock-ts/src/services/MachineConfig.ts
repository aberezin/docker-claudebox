import type { FileSystem } from "../infra/FileSystem.ts";
import { xdgRoot } from "../domain/paths.ts";
import { parseTopLevelString, parseNestedYaml } from "./ProjectConfig.ts";

/**
 * Reads the machine-wide dridock config (`<xdg>/config.yml`, with legacy
 * `<xdg>/config.yaml` fallback for one deprecation cycle) and resolves
 * per-project state paths. Ports `cb_machine_get` + `cb_data_root` +
 * `cb_project_data_dir` (wrapper.sh:131-193 + :550).
 *
 * Single source of truth: any command that touches a project's data
 * dir must route through `.projectDataDir(projectId)` here so `info`
 * (which prints it) and `start` (which mounts it) agree by construction.
 * Arfy #38 pass 5 caught InfoCommand + StartCommand disagreeing on the
 * mount source — the audit-adjacent class where a structural argv-diff
 * saw parity but the RESOLVED source differed.
 */
export class MachineConfig {
  constructor(private readonly fs: FileSystem, private readonly env: Record<string, string | undefined>, private readonly home: string) {}

  /**
   * The per-project data dir the claudebot container mounts at
   * `/home/claude/.claude`. Resolution order (bash-parity):
   *   1. `DRIDOCK_DATA_DIR` (legacy `CLAUDE_DATA_DIR`) — direct env override
   *   2. `data_root:` in `<xdg>/config.yml`, ~-expanded, then + `/<id>/claude`
   *   3. Baked default `<xdg>/projects` + `/<id>/claude`
   *
   * The env override intentionally is a FULL path (matches wrapper.sh:2168's
   * `CLAUDE_DIR=…` — the caller uses it as-is, no `/<id>/claude` suffix
   * appended). The other two paths do get the suffix.
   */
  async projectDataDir(projectId: string): Promise<string> {
    const envOverride = this.env["DRIDOCK_DATA_DIR"] ?? this.env["CLAUDE_DATA_DIR"];
    if (envOverride !== undefined && envOverride !== "") {
      return this.expandHome(envOverride);
    }
    const xdg = await xdgRoot(this.fs, this.env, this.home);
    const machineConfig = await this.fs.readTextOrUndefined(`${xdg}/config.yml`);
    let dataRoot = `${xdg}/projects`; // baked default (wrapper.sh:149)
    if (machineConfig !== undefined) {
      const configured = parseTopLevelString(machineConfig, "data_root");
      if (configured !== undefined) dataRoot = this.expandHome(configured);
    }
    return `${dataRoot}/${projectId}/claude`;
  }

  /**
   * VM sizing defaults from the machine config (`vm.default_cpu`,
   * `vm.default_memory`, `vm.default_disk`), or undefined if unset.
   * The project config's own `vm:` block overrides these; caller layers
   * the fallback. Ports the machine-level half of cb_vm_get at
   * wrapper.sh:534.
   *
   * ALSO used for count limits (`vm.warn_max`, `vm.hard_max`).
   */
  async machineDefault(key: "vm.default_cpu" | "vm.default_memory" | "vm.default_disk" | "vm.warn_max" | "vm.hard_max"): Promise<string | undefined> {
    const xdg = await xdgRoot(this.fs, this.env, this.home);
    const text = await this.fs.readTextOrUndefined(`${xdg}/config.yml`);
    if (text === undefined) return undefined;
    const [parent, child] = key.split(".") as [string, string];
    return parseNestedYaml(text, parent, child);
  }

  private expandHome(p: string): string {
    if (p === "~") return this.home;
    if (p.startsWith("~/")) return `${this.home}/${p.slice(2)}`;
    return p;
  }
}

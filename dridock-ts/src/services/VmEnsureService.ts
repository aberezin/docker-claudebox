import type { Colima } from "../infra/Colima.ts";
import { countRunningProjectVms, isCbProfile } from "../infra/Colima.ts";
import type { Docker } from "../infra/Docker.ts";
import type { FileSystem } from "../infra/FileSystem.ts";
import { projectContext, projectProfile, infraContext, INFRA_PROFILE } from "../infra/Docker.ts";
import { MachineConfig } from "./MachineConfig.ts";
import { ProjectConfig } from "./ProjectConfig.ts";
import { decideVmLimit, BAKED_WARN_MAX, BAKED_HARD_MAX } from "./VmLimits.ts";
import { cbNum } from "../domain/units.ts";

/**
 * The outcome of `ensure()` — the caller renders + acts on it.
 * Structural union so branches are exhaustive (no silent "did nothing"
 * possible — audit rule).
 */
export type VmEnsureOutcome =
  | { readonly kind: "already-running"; readonly ip: string }
  | { readonly kind: "started"; readonly ip: string; readonly warned?: boolean }
  | { readonly kind: "guard-refused"; readonly reason: "bad-profile" | "denied-by-limit"; readonly detail: string }
  | { readonly kind: "start-failed"; readonly reason: string }
  | { readonly kind: "no-reachable-ip"; readonly attemptedProfile: string };

/**
 * Ensure the project VM is up + reachable + carries the image. Ports
 * cb_ensure_vm at wrapper.sh:737 as a service composed from the extended
 * Colima + Docker adapters (P4a).
 *
 * Steps:
 *   1. Guard the profile name (cb-* prefix).
 *   2. If VM Running, return already-running + IP.
 *   3. If VM absent, require image source (cb-infra + image present).
 *   4. Check VM count against warn/hard limits.
 *   5. Read sizing from project config → machine default → baked default.
 *   6. Compute extra mounts (workspace outside $HOME needs --mount).
 *   7. colima start with those args + --network-address.
 *   8. Ensure image present in the freshly-booted VM (delegates to
 *      ImageEnsureService).
 *   9. waitReachable for the col0 IP.
 * Callers act on the outcome:
 *   - already-running / started → proceed with the IP for VmIpSidecar
 *   - guard-refused / start-failed / no-reachable-ip → abort with rc 1
 */
export interface VmEnsureDeps {
  readonly colima: Colima;
  readonly docker: Docker;
  readonly fs: FileSystem;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  readonly image: string;
  /** Image-ensure delegate — after VM boot, seed/reseed the image.
   *  Kept as a function to avoid a hard cycle back into ImageEnsureService. */
  readonly ensureImage: (context: string) => Promise<{ ok: boolean; reason?: string }>;
}

export class VmEnsureService {
  constructor(private readonly deps: VmEnsureDeps) {}

  async ensure(root: string, id: string): Promise<VmEnsureOutcome> {
    const profile = projectProfile(id);
    if (!isCbProfile(profile)) {
      return { kind: "guard-refused", reason: "bad-profile", detail: profile };
    }

    // 1. VM already running?
    const status = (await this.deps.colima.get(profile))?.status ?? "absent";
    if (status === "Running") {
      // Ensure the image is still current on this VM (drift-detect reseed).
      const seed = await this.deps.ensureImage(projectContext(id));
      if (!seed.ok) return { kind: "start-failed", reason: seed.reason ?? "image ensure failed" };
      // Ask for the reachable IP; a running VM should have one already.
      const ip = await this.deps.colima.waitReachable(profile);
      return { kind: "already-running", ip: ip ?? "" };
    }

    // 2. VM absent OR stopped. If absent, we must verify the image
    // source EXISTS before spending minutes on a doomed provision.
    if (status === "absent") {
      const source = await this.requireImageSource();
      if (!source.ok) return { kind: "start-failed", reason: source.reason };
    }

    // 3. Count guard.
    const vms = await this.deps.colima.list();
    const count = countRunningProjectVms(vms);
    const machine = new MachineConfig(this.deps.fs, this.deps.env, this.deps.home);
    const warnMax = intOr(await machine.machineDefault("vm.warn_max"), BAKED_WARN_MAX);
    const hardMax = intOr(await machine.machineDefault("vm.hard_max"), BAKED_HARD_MAX);
    const verdict = decideVmLimit(count, warnMax, hardMax);
    if (verdict === "deny") {
      return {
        kind: "guard-refused",
        reason: "denied-by-limit",
        detail: `${count} dridock VMs already running (hard_max=${hardMax}). Free one with 'dridock down' or 'dridock destroy'.`,
      };
    }
    const warned = verdict === "warn";

    // 4. Sizing (project → machine → baked).
    const cfg = new ProjectConfig(this.deps.fs);
    const configPath = `${root}/.dridock/config.yml`;
    const legacyConfigPath = `${root}/.claudebox/config.yml`;
    const resolvedConfig = (await this.deps.fs.exists(configPath)) ? configPath : legacyConfigPath;
    const cpu = await cfg.vmSize(resolvedConfig, "cpu", await machine.machineDefault("vm.default_cpu"));
    const memGiB = await cfg.vmSize(resolvedConfig, "memory", await machine.machineDefault("vm.default_memory"));
    const diskGiB = await cfg.vmSize(resolvedConfig, "disk", await machine.machineDefault("vm.default_disk"));

    // 5. Extra mounts — workspace outside $HOME needs an explicit --mount.
    const extraMounts: string[] = [];
    if (!root.startsWith(`${this.deps.home}/`) && root !== this.deps.home) {
      extraMounts.push(`${root}:w`);
    }

    // 6. `colima start`.
    const startRc = await this.deps.colima.start(profile, {
      cpu, memoryGiB: memGiB, diskGiB, networkAddress: true, extraMounts,
    });
    if (startRc !== 0) return { kind: "start-failed", reason: `colima start rc ${startRc}` };

    // 7. Image ensure now that the VM is up (seed if absent, reseed if drifted).
    const seed = await this.deps.ensureImage(projectContext(id));
    if (!seed.ok) return { kind: "start-failed", reason: seed.reason ?? "image ensure failed" };

    // 8. Wait for col0 reachability.
    const ip = await this.deps.colima.waitReachable(profile);
    if (ip === undefined) return { kind: "no-reachable-ip", attemptedProfile: profile };
    return { kind: "started", ip, warned };
  }

  /**
   * cb_require_image_source: cb-infra must be running AND must carry the
   * image. Returns ok:false with a user-facing reason otherwise.
   */
  private async requireImageSource(): Promise<{ ok: boolean; reason: string }> {
    const infraStatus = (await this.deps.colima.get(INFRA_PROFILE))?.status ?? "absent";
    if (infraStatus === "absent") {
      return { ok: false, reason: `'${INFRA_PROFILE}' colima profile not found — build the image first: make build (or make build-minimal)` };
    }
    if (infraStatus !== "Running") {
      const rc = await this.deps.colima.start(INFRA_PROFILE, {
        cpu: 2, memoryGiB: 4, diskGiB: 40, networkAddress: false,
      });
      if (rc !== 0) return { ok: false, reason: `failed to start ${INFRA_PROFILE} (rc ${rc})` };
    }
    const identity = await this.deps.docker.imageIdentity(infraContext(), this.deps.image);
    if (identity === undefined) {
      return { ok: false, reason: `${this.deps.image} not present in ${INFRA_PROFILE} — build it: make build (or make build-minimal)` };
    }
    return { ok: true, reason: "" };
  }
}

function intOr(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  try { return Math.floor(cbNum(s)); } catch { return fallback; }
}

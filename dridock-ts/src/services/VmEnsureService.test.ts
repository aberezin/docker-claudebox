import { test, expect, describe } from "bun:test";
import { VmEnsureService } from "./VmEnsureService.ts";
import { ImageEnsureService } from "./ImageEnsureService.ts";
import { InMemoryColima } from "../test/fakes/InMemoryColima.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { infraContext } from "../infra/Docker.ts";

function build(
  fs: InMemoryFileSystem = new InMemoryFileSystem(),
  colima: InMemoryColima = new InMemoryColima(),
  docker: InMemoryDocker = new InMemoryDocker(),
  env: Record<string, string | undefined> = {},
): { svc: VmEnsureService; fs: InMemoryFileSystem; colima: InMemoryColima; docker: InMemoryDocker } {
  const imgSvc = new ImageEnsureService({ docker, colima, image: "dridock:latest" });
  const svc = new VmEnsureService({
    colima, docker, fs, env, home: "/home/alan", image: "dridock:latest",
    ensureImage: imgSvc.asCallback(),
  });
  return { svc, fs, colima, docker };
}

function seedInfraWithImage(colima: InMemoryColima, docker: InMemoryDocker, version = "3.3.7"): void {
  colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
  docker.seedImage(infraContext(), "dridock:latest", version);
  docker.seedImageIdentity(infraContext(), "dridock:latest", { id: "sha256:infra-1", labels: { "org.dridock.version": version } });
}

describe("VmEnsureService.ensure — happy paths", () => {
  test("VM already running + image present → already-running with IP", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    colima.seedVm({ name: "cb-abc", status: "Running", address: "192.168.64.13" });
    docker.seedImage("colima-cb-abc", "dridock:latest", "3.3.7");
    docker.seedImageIdentity("colima-cb-abc", "dridock:latest", { id: "sha256:infra-1", labels: {} });
    const r = await svc.ensure("/repo", "abc");
    expect(r).toEqual({ kind: "already-running", ip: "192.168.64.13" });
    // No start invoked — VM was already up
    expect(colima.starts).toEqual([]);
  });

  test("VM absent + cb-infra running with image → start + first-seed → started with IP", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(r.ip).toBe("192.168.64.100"); // InMemoryColima's deterministic address
      expect(r.warned).toBe(false);
    }
    // Colima start invoked with network-address, correct profile
    expect(colima.starts.length).toBe(1);
    expect(colima.starts[0]!.profile).toBe("cb-abc");
    expect(colima.starts[0]!.opts.networkAddress).toBe(true);
    // Image was seeded (save|load recorded)
    expect(docker.saves).toEqual([{
      source: "colima-cb-infra", image: "dridock:latest", target: "colima-cb-abc",
    }]);
  });

  test("workspace under $HOME → no --mount arg", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    await svc.ensure("/home/alan/proj", "abc");
    expect(colima.starts[0]!.opts.extraMounts ?? []).toEqual([]);
  });

  test("workspace OUTSIDE $HOME → adds --mount PATH:w (writable)", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    await svc.ensure("/mnt/scratch", "abc");
    expect(colima.starts[0]!.opts.extraMounts).toEqual(["/mnt/scratch:w"]);
  });

  test("project vm.cpu/memory/disk override machine defaults + baked defaults", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/repo/.dridock/config.yml", "id: abc\nvm:\n  cpu: 8\n  memory: 16GiB\n  disk: 200GiB\n");
    // Machine config sets a different default — project should win.
    fs.seed("/home/alan/.config/dridock/config.yml", "vm:\n  default_cpu: 2\n  default_memory: 4GiB\n  default_disk: 50GiB\n");
    const { svc, colima, docker } = build(fs);
    seedInfraWithImage(colima, docker);
    await svc.ensure("/repo", "abc");
    expect(colima.starts[0]!.opts).toMatchObject({ cpu: 8, memoryGiB: 16, diskGiB: 200 });
  });

  test("machine defaults apply when project has no vm: block", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/config.yml", "vm:\n  default_cpu: 6\n  default_memory: 12GiB\n  default_disk: 80GiB\n");
    const { svc, colima, docker } = build(fs);
    seedInfraWithImage(colima, docker);
    await svc.ensure("/repo", "abc");
    expect(colima.starts[0]!.opts).toMatchObject({ cpu: 6, memoryGiB: 12, diskGiB: 80 });
  });

  test("baked defaults apply when neither project nor machine config sets sizing", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    await svc.ensure("/repo", "abc");
    // Baked: cpu 4, memory 8GiB, disk 100GiB (wrapper.sh:143-146)
    expect(colima.starts[0]!.opts).toMatchObject({ cpu: 4, memoryGiB: 8, diskGiB: 100 });
  });
});

describe("VmEnsureService.ensure — guards + failure modes", () => {
  test("empty id → profile is 'cb-' which fails the `cb-.+` guard → guard-refused (never silently succeeds)", async () => {
    const { svc } = build();
    const r = await svc.ensure("/repo", "");
    expect(r.kind).toBe("guard-refused");
    if (r.kind === "guard-refused") {
      expect(r.reason).toBe("bad-profile");
      expect(r.detail).toBe("cb-");
    }
  });

  test("VM absent + cb-infra absent → start-failed with 'not found — build the image'", async () => {
    const { svc } = build();
    // No cb-infra seeded
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("start-failed");
    if (r.kind === "start-failed") expect(r.reason).toContain("not found");
  });

  test("VM absent + cb-infra running but image not present → start-failed", async () => {
    const { svc, colima } = build();
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    // No image seeded in cb-infra
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("start-failed");
    if (r.kind === "start-failed") expect(r.reason).toContain("not present in cb-infra");
  });

  test("hard_max reached → guard-refused with 'deny'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/config.yml", "vm:\n  warn_max: 1\n  hard_max: 2\n");
    const { svc, colima, docker } = build(fs);
    seedInfraWithImage(colima, docker);
    // Two other project VMs already running — count hits hard_max.
    colima.seedVm({ name: "cb-existing1", status: "Running", address: "1.1.1.1" });
    colima.seedVm({ name: "cb-existing2", status: "Running", address: "2.2.2.2" });
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("guard-refused");
    if (r.kind === "guard-refused") {
      expect(r.reason).toBe("denied-by-limit");
      expect(r.detail).toContain("hard_max=2");
    }
    // Never invoked start
    expect(colima.starts.filter((s) => s.profile === "cb-abc")).toEqual([]);
  });

  test("warn_max reached → started with warned:true (proceeds)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/home/alan/.config/dridock/config.yml", "vm:\n  warn_max: 1\n  hard_max: 5\n");
    const { svc, colima, docker } = build(fs);
    seedInfraWithImage(colima, docker);
    colima.seedVm({ name: "cb-existing1", status: "Running", address: "1.1.1.1" });
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("started");
    if (r.kind === "started") expect(r.warned).toBe(true);
  });

  test("colima start rc != 0 → start-failed", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    colima.nextStartRc = 1;
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("start-failed");
    if (r.kind === "start-failed") expect(r.reason).toContain("rc 1");
  });

  test("waitReachable timeout → no-reachable-ip", async () => {
    const { svc, colima, docker } = build();
    seedInfraWithImage(colima, docker);
    colima.nextWaitReachableSuccess = false;
    const r = await svc.ensure("/repo", "abc");
    expect(r.kind).toBe("no-reachable-ip");
  });
});

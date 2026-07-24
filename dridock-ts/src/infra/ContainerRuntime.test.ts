import { test, expect, describe } from "bun:test";
import { buildRunArgv } from "./ContainerRuntime.ts";
import { InMemoryContainerRuntime } from "../test/fakes/InMemoryContainerRuntime.ts";

describe("buildRunArgv — the docker run command line", () => {
  test("minimum shape: docker --context X run --name Y -it Z cmd...", () => {
    const argv = buildRunArgv({
      context: "colima-cb-abc",
      containerName: "claude-_p",
      image: "dridock:latest",
      mounts: [],
      env: [],
      mode: "interactive",
      cmd: ["claude", "--dangerously-skip-permissions"],
      publishPorts: [],
    });
    expect(argv).toEqual([
      "docker", "--context", "colima-cb-abc", "run",
      "--name", "claude-_p", "-it",
      "dridock:latest", "claude", "--dangerously-skip-permissions",
    ]);
  });

  test("detached uses -d instead of -it", () => {
    const argv = buildRunArgv({
      context: "cx", containerName: "c", image: "i",
      mounts: [], env: [], mode: "detached",
      cmd: ["cmd"], publishPorts: [],
    });
    expect(argv).toContain("-d");
    expect(argv).not.toContain("-it");
  });

  test("attached mode: NEITHER -it NOR -d (bash prog mode — wrapper.sh:3288)", () => {
    const argv = buildRunArgv({
      context: "cx", containerName: "c", image: "i",
      mounts: [], env: [], mode: "attached",
      cmd: ["cmd"], publishPorts: [],
    });
    expect(argv).not.toContain("-it");
    expect(argv).not.toContain("-d");
    // Sanity: image + cmd still appended after run flags
    expect(argv.indexOf("i")).toBeLessThan(argv.indexOf("cmd"));
  });

  test("mounts render as -v with :ro suffix when opts.ro", () => {
    const argv = buildRunArgv({
      context: "cx", containerName: "c", image: "i",
      mounts: [
        { host: "/home/alan/proj", container: "/home/alan/proj" },
        { host: "/home/alan/.ssh/claudebox", container: "/home/claude/.ssh", ro: true },
      ],
      env: [], mode: "interactive", cmd: [], publishPorts: [],
    });
    expect(argv).toContain("/home/alan/proj:/home/alan/proj");
    expect(argv).toContain("/home/alan/.ssh/claudebox:/home/claude/.ssh:ro");
  });

  test("env pairs render as -e KEY=VALUE", () => {
    const argv = buildRunArgv({
      context: "cx", containerName: "c", image: "i",
      mounts: [],
      env: [{ key: "GH_TOKEN", value: "ghp_abc" }, { key: "MODE", value: "cron" }],
      mode: "interactive", cmd: [], publishPorts: [],
    });
    const eIdx = argv.reduce<number[]>((acc, tok, i) => (tok === "-e" ? [...acc, i] : acc), []);
    expect(eIdx.length).toBe(2);
    expect(argv[eIdx[0]! + 1]).toBe("GH_TOKEN=ghp_abc");
    expect(argv[eIdx[1]! + 1]).toBe("MODE=cron");
  });

  test("envFile renders as --env-file BEFORE inline -e (bash-parity: file first, overrides win)", () => {
    const argv = buildRunArgv({
      context: "cx", containerName: "c", image: "i",
      mounts: [], envFile: "/tmp/env", env: [{ key: "A", value: "B" }],
      mode: "interactive", cmd: [], publishPorts: [],
    });
    const envFileIdx = argv.indexOf("--env-file");
    const eIdx = argv.indexOf("-e");
    expect(envFileIdx).toBeLessThan(eIdx);
  });

  test("network + workdir + publishPorts", () => {
    const argv = buildRunArgv({
      context: "cx", containerName: "c", image: "i",
      mounts: [], env: [], mode: "interactive",
      network: "cb-net", workdir: "/work",
      publishPorts: ["8080:8080", "9229:9229"],
      cmd: [],
    });
    expect(argv).toContain("--network");
    expect(argv).toContain("cb-net");
    expect(argv).toContain("-w");
    expect(argv).toContain("/work");
    expect(argv.filter((a) => a === "-p").length).toBe(2);
    expect(argv).toContain("8080:8080");
    expect(argv).toContain("9229:9229");
  });
});

describe("InMemoryContainerRuntime", () => {
  test("psFilter returns seeded row or undefined", async () => {
    const rt = new InMemoryContainerRuntime();
    rt.seedPs("claude-_p", { name: "claude-_p", status: "Exited (0) 5 min", image: "dridock:latest" });
    expect(await rt.psFilter("cx", "claude-_p")).toEqual({
      name: "claude-_p", status: "Exited (0) 5 min", image: "dridock:latest",
    });
    expect(await rt.psFilter("cx", "claude-nonexistent")).toBeUndefined();
  });

  test("runInteractive records the RunArgs; rc from nextRc when seeded", async () => {
    const rt = new InMemoryContainerRuntime();
    rt.nextRc.set("run:claude-_p", 42);
    const rc = await rt.runInteractive({
      context: "cx", containerName: "claude-_p", image: "i",
      mounts: [], env: [], mode: "interactive", cmd: [], publishPorts: [],
    });
    expect(rc).toBe(42);
    expect(rt.runs.length).toBe(1);
    expect(rt.runs[0]!.containerName).toBe("claude-_p");
  });

  test("startAttached / stop / execDetached record their calls", async () => {
    const rt = new InMemoryContainerRuntime();
    await rt.startAttached("cx", "c1");
    await rt.stop("cx", "c1");
    await rt.execDetached("cx", "c1", ["echo", "hi"]);
    expect(rt.starts).toEqual([{ context: "cx", container: "c1" }]);
    expect(rt.stops).toEqual([{ context: "cx", container: "c1" }]);
    expect(rt.execs).toEqual([{ context: "cx", container: "c1", cmd: ["echo", "hi"] }]);
  });
});

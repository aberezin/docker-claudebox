import { test, expect, describe } from "bun:test";
import { ContainerRefresher, staleRunningMessage, shortId } from "./ContainerRefresher.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";

describe("ContainerRefresher.maybeRefresh", () => {
  test("container's imageId matches image's current id → current, nothing removed", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:X" });
    docker.seedImageIdentity("cx", "img", { id: "sha256:X", labels: {} });
    expect(await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img")).toEqual({ kind: "current" });
    expect(docker.removals).toEqual([]);
  });

  test("stale and STOPPED → removed (non-force) so the run path recreates it", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:OLD", status: "exited" });
    docker.seedImageIdentity("cx", "img", { id: "sha256:NEW", labels: {} });
    expect(await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img")).toEqual({ kind: "recreated" });
    expect(docker.removals).toEqual([{ context: "cx", name: "c1" }]);
  });

  test("#126: stale but RUNNING → left alone, reported with both image ids", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:OLD", status: "running" });
    docker.seedImageIdentity("cx", "img", { id: "sha256:NEW", labels: {} });
    expect(await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img"))
      .toEqual({ kind: "running", status: "running", from: "sha256:OLD", to: "sha256:NEW" });
    expect(docker.removals).toEqual([]);
  });

  test.each(["paused", "restarting"])("#126: stale and %s → live too, on the primary path (not the rm backstop)", async (st) => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:OLD", status: st });
    docker.seedImageIdentity("cx", "img", { id: "sha256:NEW", labels: {} });
    const r = await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img");
    expect(r).toEqual({ kind: "running", status: st, from: "sha256:OLD", to: "sha256:NEW" });
    expect(staleRunningMessage("c1", r as { from: string; to: string; status: string }, "dridock")).toContain(`c1 is ${st} on an older image`);
    expect(docker.removals).toEqual([]);
  });

  test("#126: started between the check and the rm → the daemon refuses, nothing killed", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:OLD", status: "exited" });
    docker.seedImageIdentity("cx", "img", { id: "sha256:NEW", labels: {} });
    docker.rmRefuses.add("c1");
    expect(await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img"))
      .toEqual({ kind: "remove-failed", rc: 1, from: "sha256:OLD", to: "sha256:NEW" });
    expect(docker.removals).toEqual([]);
  });

  test("container absent → current", async () => {
    const docker = new InMemoryDocker();
    docker.seedImageIdentity("cx", "img", { id: "sha256:X", labels: {} });
    expect((await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img")).kind).toBe("current");
  });

  test("image absent → current (nothing to compare against)", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:X" });
    expect((await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img")).kind).toBe("current");
  });
});

test("#126 message: names both images, says nothing started, gives the way forward", () => {
  const m = staleRunningMessage("claude-p-1", { from: "sha256:aaaaaaaaaaaa99", to: "sha256:bbbbbbbbbbbb99" }, "dridock");
  expect(m).toContain("claude-p-1 is running on an older image (aaaaaaaaaaaa; the project image is now bbbbbbbbbbbb)");
  expect(m).toContain("nothing was started");
  expect(m).toContain("dridock down && dridock start");
  expect(shortId("sha256:0123456789abcdef")).toBe("0123456789ab");
});

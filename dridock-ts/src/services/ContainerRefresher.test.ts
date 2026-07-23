import { test, expect, describe } from "bun:test";
import { ContainerRefresher } from "./ContainerRefresher.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";

describe("ContainerRefresher.maybeRefresh", () => {
  test("container's imageId matches image's current id → no-op, returns false", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:X" });
    docker.seedImageIdentity("cx", "img", { id: "sha256:X", labels: {} });
    const removed = await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img");
    expect(removed).toBe(false);
    expect(docker.removals).toEqual([]);
  });

  test("container's imageId != image's current id → containerRemove, returns true", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:OLD" });
    docker.seedImageIdentity("cx", "img", { id: "sha256:NEW", labels: {} });
    const removed = await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img");
    expect(removed).toBe(true);
    expect(docker.removals).toEqual([{ context: "cx", name: "c1" }]);
  });

  test("container absent → no-op, returns false (no error)", async () => {
    const docker = new InMemoryDocker();
    docker.seedImageIdentity("cx", "img", { id: "sha256:X", labels: {} });
    expect(await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img")).toBe(false);
    expect(docker.removals).toEqual([]);
  });

  test("image absent → no-op, returns false (nothing to compare against)", async () => {
    const docker = new InMemoryDocker();
    docker.seedContainer("cx", "c1", { name: "c1", imageId: "sha256:X" });
    // No image seeded
    expect(await new ContainerRefresher(docker).maybeRefresh("cx", "c1", "img")).toBe(false);
    expect(docker.removals).toEqual([]);
  });
});

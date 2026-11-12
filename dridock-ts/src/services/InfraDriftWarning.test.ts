import { test, expect, describe } from "bun:test";
import { driftWarningLines, checkInfraDrift, HARNESS_FINGERPRINT } from "./InfraDriftWarning.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import { IMAGE_UNAVAILABLE, IMAGE_UNSTAMPED, infraContext } from "../infra/Docker.ts";

const base = { wrapperVersion: "5.14.0", image: "dridock:latest", variant: "full" as const, binName: "dridock" };

describe("driftWarningLines (#110)", () => {
  test("same version, unavailable, unstamped → silent", () => {
    for (const iv of ["5.14.0", IMAGE_UNAVAILABLE, IMAGE_UNSTAMPED, ""]) {
      expect(driftWarningLines({ ...base, infraVersion: iv })).toEqual([]);
    }
  });

  test("severity picks the head line; remedy is the full image's target", () => {
    expect(driftWarningLines({ ...base, infraVersion: "4.3.4" })[0]).toContain("🔴");
    expect(driftWarningLines({ ...base, infraVersion: "5.12.0" })[0]).toContain("🟠");
    expect(driftWarningLines({ ...base, infraVersion: "5.13.9" })[0]).toContain("MINOR");
    const p2 = driftWarningLines({ ...base, wrapperVersion: "5.14.1", infraVersion: "5.14.0" });
    expect(p2[0]).toContain("🟡");
    expect(p2[0]).toContain("make build");
    expect(p2[0]).not.toContain("build-minimal");
    expect(p2.join("")).toContain("DRIDOCK_NO_DRIFT_WARN=1");
  });

  test("minimal in use → names latest-minimal and make build-minimal", () => {
    const l = driftWarningLines({ ...base, image: "dridock:latest-minimal", variant: "minimal", infraVersion: "4.3.4" });
    expect(l[0]).toContain("dridock:latest-minimal (4.3.4)");
    expect(l[0]).toContain("make build-minimal");
  });

  test("custom image → no make target", () => {
    const l = driftWarningLines({ ...base, image: "me/img:1", variant: "custom", infraVersion: "5.13.0" });
    expect(l[0]).toContain("DRIDOCK_IMAGE");
    expect(l[0]).not.toContain("make build");
  });

  test("image ahead of wrapper → points at install.sh", () => {
    const l = driftWarningLines({ ...base, infraVersion: "5.15.0" });
    expect(l[0]).toContain("AHEAD");
    expect(l[0]).toContain("./install.sh");
  });
});

describe("checkInfraDrift (#110)", () => {
  function setup(env: Record<string, string> = {}) {
    const docker = new InMemoryDocker();
    docker.seedImage(infraContext(), "dridock:latest", "5.14.0");
    docker.seedImage(infraContext(), "dridock:latest-minimal", "4.3.4");
    const fs = new InMemoryFileSystem();
    return { docker, fs, env: new EnvResolver(env) };
  }

  test("LOAD-BEARING: reads cb-infra for the image THIS run uses, not dridock:latest", async () => {
    const d = setup();
    const full = await checkInfraDrift(d, "/p", base);
    expect(full).toEqual([]);
    const min = await checkInfraDrift(d, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" });
    expect(min.join("")).toContain("dridock:latest-minimal (4.3.4)");
  });

  test("DRIDOCK_NO_DRIFT_WARN=1 silences", async () => {
    const d = setup({ DRIDOCK_NO_DRIFT_WARN: "1" });
    expect(await checkInfraDrift(d, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" })).toEqual([]);
  });

  test("harness checkout (fingerprint) and DRIDOCK_HARNESS_DEV=1 are skipped", async () => {
    const d = setup();
    d.fs.seed(`/p/${HARNESS_FINGERPRINT}`, "export const DRIDOCK_TS_VERSION = \"5.14.0\";\n");
    expect(await checkInfraDrift(d, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" })).toEqual([]);
    const d2 = setup({ DRIDOCK_HARNESS_DEV: "1" });
    expect(await checkInfraDrift(d2, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" })).toEqual([]);
    const d3 = setup({ DRIDOCK_FRAMEWORK_DEV: "yes" });
    expect(await checkInfraDrift(d3, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" })).toEqual([]);
    // entrypoint.sh precedence: a set HARNESS_DEV wins over the legacy alias.
    const d4 = setup({ DRIDOCK_HARNESS_DEV: "0", DRIDOCK_FRAMEWORK_DEV: "1" });
    expect((await checkInfraDrift(d4, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" })).length).toBeGreaterThan(0);
  });

  test("an unrecognised opt-out value does not silence (only 1/true/yes/on do)", async () => {
    const d = setup({ DRIDOCK_NO_DRIFT_WARN: "0" });
    expect((await checkInfraDrift(d, "/p", { ...base, image: "dridock:latest-minimal", variant: "minimal" })).length).toBeGreaterThan(0);
  });
});

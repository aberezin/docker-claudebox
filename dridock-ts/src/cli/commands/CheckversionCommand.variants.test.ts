import { test, expect, describe } from "bun:test";
import { CheckversionCommand } from "./CheckversionCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";
import { resolveImage } from "../../domain/ImageRef.ts";
import { assessVariants, dockerfilePin } from "../../services/CheckVersion.ts";

// Spec: #109 — checkversion looked at dridock:latest only, and printed
// "✅ in sync" on a host whose dridock:latest-minimal was ten releases behind.

const INFRA = "colima-cb-infra";
const PIN = "2.1.319";
const FULL = "dridock:latest";
const MIN = "dridock:latest-minimal";

/** The host from the ticket (Arfy, macOS, 2026-11-12): full current, minimal
 *  at harness 4.3.4 and built before #78, so it has NO claude-version label. */
function arfyHost(docker = new InMemoryDocker()): InMemoryDocker {
  docker.seedImage(INFRA, FULL, DRIDOCK_TS_VERSION);
  docker.seedImageIdentity(INFRA, FULL, { id: "sha256:f", labels: { "org.dridock.version": DRIDOCK_TS_VERSION, "org.dridock.claude-version": PIN } });
  docker.seedImage(INFRA, MIN, "4.3.4");
  docker.seedImageIdentity(INFRA, MIN, { id: "sha256:m", labels: { "org.dridock.version": "4.3.4" } });
  return docker;
}

/** A harness checkout at /repo: the fingerprint plus a Dockerfile pin. */
function harnessCheckout(fs = new InMemoryFileSystem(), pin = PIN): InMemoryFileSystem {
  fs.seed("/repo/dridock-ts/src/domain/dridockVersion.ts", "");
  fs.seed("/repo/Dockerfile", `# comment\nARG CLAUDE_VERSION=${pin}\nFROM x\nARG CLAUDE_VERSION=9.9.9\n`);
  return fs;
}

async function run(docker: InMemoryDocker, fs: InMemoryFileSystem, env: Record<string, string> = {}, cwd = "/repo") {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  const ctx: Context = { fs, env: new EnvResolver(env), cwd, home: "/h", binName: "dridock", stdout, stderr };
  const choice = resolveImage(new EnvResolver(env));
  const rc = await new CheckversionCommand(choice.image, docker, new StubGitToplevel(cwd), new InMemoryColima(), async () => undefined, choice).run([], ctx);
  return { rc, out: stdout.text() };
}

describe("checkversion — every variant tag in cb-infra (#109)", () => {
  test("the ticket's host: the stale minimal is reported, and 'in sync' is no longer unqualified", async () => {
    const { rc, out } = await run(arfyHost(), harnessCheckout());
    expect(rc).toBe(0);
    expect(out).toContain(`claude pin ${PIN} from /repo/Dockerfile`);
    expect(out).toMatch(/dridock:latest-minimal\s+4\.3\.4\s+claude \?/);
    expect(out).toContain(`harness 4.3.4, but the wrapper is ${DRIDOCK_TS_VERSION}`);
    // The case a hand-built fixture would most easily miss: no label at all.
    expect(out).toContain("no org.dridock.claude-version label: built before #78");
    expect(out).toContain("Rebuild on the Mac: make build-minimal");
    expect(out).not.toContain("✅ in sync — wrapper and claudebot image");
    expect(out).toContain(`the image dridock runs (${FULL}) matches the wrapper`);
    expect(out).toContain(`but ${MIN} is stale`);
  });

  test("both variants current and labelled → plain in-sync, both ✓", async () => {
    const docker = arfyHost();
    docker.seedImageIdentity(INFRA, MIN, { id: "sha256:m2", labels: { "org.dridock.version": DRIDOCK_TS_VERSION, "org.dridock.claude-version": PIN } });
    const { out } = await run(docker, harnessCheckout());
    expect(out).toContain(`✅ in sync — wrapper and claudebot image (${FULL}) are both ${DRIDOCK_TS_VERSION}.`);
    expect(out).not.toContain("is stale");
  });

  test("minimal never built → 'not built', no warning", async () => {
    const docker = new InMemoryDocker();
    docker.seedImage(INFRA, FULL, DRIDOCK_TS_VERSION);
    docker.seedImageIdentity(INFRA, FULL, { id: "sha256:f", labels: { "org.dridock.version": DRIDOCK_TS_VERSION, "org.dridock.claude-version": PIN } });
    const { out } = await run(docker, harnessCheckout());
    expect(out).toMatch(/dridock:latest-minimal\s+not built/);
    expect(out).toContain("✅ in sync — wrapper and claudebot image");
  });

  test("full image baking an older claude than the pin is flagged, even though it is the one in use", async () => {
    const docker = arfyHost();
    docker.seedImageIdentity(INFRA, FULL, { id: "sha256:f", labels: { "org.dridock.version": DRIDOCK_TS_VERSION, "org.dridock.claude-version": "2.1.300" } });
    const { out } = await run(docker, harnessCheckout());
    expect(out).toContain(`${FULL} is stale (and it is the image dridock runs)`);
    expect(out).toContain(`bakes claude 2.1.300, but the Dockerfile pins ${PIN}`);
  });

  test("DRIDOCK_MINIMAL=1 makes minimal the image in use: the outcome compares IT, not the full image", async () => {
    const { out } = await run(arfyHost(), harnessCheckout(), { DRIDOCK_MINIMAL: "1" });
    expect(out).toMatch(/dridock:latest-minimal.*← in use/);
    expect(out).toContain("version drift: wrapper");
    expect(out).toContain("claudebot image 4.3.4");
  });

  test("drift under DRIDOCK_MINIMAL prescribes make build-minimal, never the full-image make build (Arfy #109 must-fix 1)", async () => {
    const { out } = await run(arfyHost(), harnessCheckout(), { DRIDOCK_MINIMAL: "1" });
    expect(out).toContain("rebuild the image, then restart:  make build-minimal");
    expect(out).not.toMatch(/make build\n/);
  });

  test("an unstamped minimal in use → the stamp remedy names make build-minimal", async () => {
    const docker = new InMemoryDocker();
    docker.seedImage(INFRA, MIN, "unstamped");
    const { out } = await run(docker, harnessCheckout(), { DRIDOCK_MINIMAL: "1" });
    expect(out).toContain("Rebuild to stamp it: make build-minimal");
  });

  test("DRIDOCK_IMAGE not reachable → says no make target builds it, names none", async () => {
    const { out } = await run(new InMemoryDocker(), harnessCheckout(), { DRIDOCK_IMAGE: "nosuch:tag" });
    expect(out).toContain("nosuch:tag comes from DRIDOCK_IMAGE, which no make target builds");
    expect(out).not.toMatch(/: make build/);
  });

  test("full image in use still gets plain make build", async () => {
    const docker = new InMemoryDocker();
    docker.seedImage(INFRA, FULL, "5.0.0");
    const { out } = await run(docker, harnessCheckout());
    expect(out).toContain("rebuild the image, then restart:  make build\n");
  });

  test("a USER project's Dockerfile is not taken as the pin (no harness fingerprint)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/app/Dockerfile", "ARG CLAUDE_VERSION=9.9.9\n");
    const { out } = await run(arfyHost(), fs, {}, "/app");
    expect(out).not.toContain("9.9.9");
    expect(out).not.toContain("claude pin");
    // Still loud about the minimal image without a pin.
    expect(out).toContain("no org.dridock.claude-version label");
  });

  test("DRIDOCK_IMAGE names one image: the variant tags aren't guessed at", async () => {
    const docker = arfyHost();
    docker.seedImage(INFRA, "reg/cb:dev", DRIDOCK_TS_VERSION);
    docker.seedImageIdentity(INFRA, "reg/cb:dev", { id: "sha256:c", labels: { "org.dridock.version": DRIDOCK_TS_VERSION, "org.dridock.claude-version": PIN } });
    const { out } = await run(docker, harnessCheckout(), { DRIDOCK_IMAGE: "reg/cb:dev" });
    expect(out).toMatch(/reg\/cb:dev.*← in use/);
    expect(out).toContain("image in cb-infra (DRIDOCK_IMAGE)");
    expect(out).not.toContain("image variants in cb-infra");
    expect(out).not.toContain(MIN);
  });

  test("cb-infra down (no image inspectable) → no variant section; the outcome reports it", async () => {
    const { out } = await run(new InMemoryDocker(), harnessCheckout());
    expect(out).not.toContain("image variants in cb-infra");
    expect(out).toContain("no built image reachable");
  });
});

describe("assessVariants — pure", () => {
  test("no pin: variants are compared with the one in use", () => {
    const [, min] = assessVariants({
      wrapperVersion: "5.14.0", inUse: FULL,
      variants: [
        { tag: FULL, labels: { "org.dridock.version": "5.14.0", "org.dridock.claude-version": "2.1.319" } },
        { tag: MIN, labels: { "org.dridock.version": "5.14.0", "org.dridock.claude-version": "2.1.215" } },
      ],
    });
    expect(min!.problems).toEqual([`bakes claude 2.1.215, but ${FULL} bakes 2.1.319`]);
  });
  test("the tag in use isn't re-flagged for harness drift (classify already says it)", () => {
    const [full] = assessVariants({
      wrapperVersion: "5.14.0", inUse: FULL, pin: "2.1.319",
      variants: [{ tag: FULL, labels: { "org.dridock.version": "5.13.0", "org.dridock.claude-version": "2.1.319" } }],
    });
    expect(full!.problems).toEqual([]);
  });
  test("legacy org.claudebox.version is read; '<no value>' counts as absent", () => {
    const [v] = assessVariants({
      wrapperVersion: "5.14.0", inUse: "x", pin: "2.1.319",
      variants: [{ tag: MIN, labels: { "org.claudebox.version": "2.9.0", "org.dridock.claude-version": "<no value>" } }],
    });
    expect(v!.version).toBe("2.9.0");
    expect(v!.claude).toBeUndefined();
    expect(v!.problems.length).toBe(2);
  });
  test("dockerfilePin takes the first ARG, like install.sh's sed | head -1", () => {
    expect(dockerfilePin("FROM a\nARG CLAUDE_VERSION=2.1.319\nARG CLAUDE_VERSION=1.0.0\n")).toBe("2.1.319");
    expect(dockerfilePin("ARG CLAUDE_VERSION\n")).toBeUndefined();
    // sed's [^ ]* stops at a SPACE only: a trailing tab is kept, so this keeps it too.
    expect(dockerfilePin("ARG CLAUDE_VERSION=2.1.319 # pin\n")).toBe("2.1.319");
    expect(dockerfilePin("ARG CLAUDE_VERSION=2.1.319\t\n")).toBe("2.1.319\t");
  });
});

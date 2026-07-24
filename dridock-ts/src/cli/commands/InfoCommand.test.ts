import { test, expect, describe } from "bun:test";
import { InfoCommand } from "./InfoCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { InMemoryColima } from "../../test/fakes/InMemoryColima.ts";
import { InMemoryContainerRuntime } from "../../test/fakes/InMemoryContainerRuntime.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): { ctx: Context; stdout: StringWriter } {
  const stdout = new StringWriter();
  return {
    stdout,
    ctx: { fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock", stdout, stderr: new StringWriter() },
  };
}

describe("InfoCommand — bare directory", () => {
  test("no config.yml → 'not a dridock project yet' + no image (project) row", async () => {
    const fs = new InMemoryFileSystem();
    const { ctx, stdout } = makeCtx(fs, "/scratch");
    const rc = await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/scratch"), new InMemoryColima()).run([], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain(`wrapper (host):    ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain("workspace:         /scratch");
    expect(out).toContain("not a dridock project yet");
    expect(out).not.toContain("image (project):");
    // Machine block still renders (cb-infra status)
    expect(out).toContain("machine:");
    expect(out).toContain("cb-infra:          absent");
  });
});

describe("InfoCommand — full project (P4c — no more Phase-3 stubs)", () => {
  test("VM Running + container running + reachable IP → real values on every row", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc12345\nnetwork:\n  hostname: my-app\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc12345", "dridock:latest", "3.3.7");
    docker.seedClaudeCliVersion("colima-cb-abc12345", "dridock:latest", "0.5.14");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc12345", status: "Running", address: "192.168.64.13" });
    colima.seedVm({ name: "cb-infra", status: "Running", address: "" });
    // Container status now flows via ContainerRuntime.psFilter (matches
    // bash's `docker ps --format '{{.Status}}'` — human-readable "Up 3
    // minutes" — instead of `.State.Status`'s "running"). Arfy #38 P4c
    // B2 fix.
    const runtime = new InMemoryContainerRuntime();
    runtime.seedPs("claude-_p", { name: "claude-_p", status: "Up 3 minutes", image: "dridock:latest" });
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", docker, new StubGitToplevel("/p"), colima, runtime).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("VM:                cb-abc12345   (Running)");
    expect(out).toContain("container:         claude-_p   Up 3 minutes");
    expect(out).toContain("VM IP:             192.168.64.13");
    expect(out).toContain("browse:            http://192.168.64.13:<port>");
    expect(out).toContain("hostname:          my-app");
    expect(out).toContain("→ http://my-app:<port>");
    expect(out).toContain("cb-net:            cb-net");
    expect(out).toContain("cb-infra:          Running");
    // Phase 3 stub strings must be GONE
    expect(out).not.toContain("Phase 3 stub");
    expect(out).not.toContain("use bash wrapper");
  });

  test("VM Stopped → 'container status unavailable' + no VM IP row", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Stopped", address: "" });
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), colima).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("VM:                cb-abc   (Stopped)");
    expect(out).toContain("container:         claude-_p   (VM not running — status unavailable)");
    expect(out).toContain("VM IP:             (VM not running — start with 'dridock start')");
  });

  test("VM Running but no container → 'container: claude-_p <none>'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    // No container seeded
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), colima).run([], ctx);
    expect(stdout.text()).toContain("container:         claude-_p   <none>");
  });

  test("no network.hostname set → the '(unset — set network.hostname …)' hint", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-abc", status: "Running", address: "1.2.3.4" });
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), colima).run([], ctx);
    expect(stdout.text()).toContain("hostname:          (unset");
  });

  test("cb-infra Stopped → machine row shows 'Stopped'", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const colima = new InMemoryColima();
    colima.seedVm({ name: "cb-infra", status: "Stopped", address: "" });
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), colima).run([], ctx);
    expect(stdout.text()).toContain("cb-infra:          Stopped");
  });

  test("data-dir path honors machine-config data_root override", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    fs.seed("/home/alan/.config/dridock/config.yml", "data_root: ~/custom-data\n");
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), new InMemoryColima()).run([], ctx);
    expect(stdout.text()).toContain("/home/alan/custom-data/abc/claude");
  });

  test("secrets.env row: absent → hint; present → key count", async () => {
    const fs1 = new InMemoryFileSystem();
    fs1.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx: c1, stdout: s1 } = makeCtx(fs1);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), new InMemoryColima()).run([], c1);
    expect(s1.text()).toContain("secrets.env:       (none");

    const fs2 = new InMemoryFileSystem();
    fs2.seed("/p/.dridock/config.yml", "id: abc\n");
    fs2.seed("/p/.dridock/secrets.env", [
      "GH_TOKEN=1", "# comment", "", "OPENAI_KEY=2", "not-a-key", "ANTHROPIC_KEY=3",
    ].join("\n") + "\n");
    const { ctx: c2, stdout: s2 } = makeCtx(fs2);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), new InMemoryColima()).run([], c2);
    expect(s2.text()).toContain("(3 key(s))");
  });

  test("legacy .claudebox project: paths resolve to legacy dot dir", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/p/.claudebox");
    fs.seed("/p/.claudebox/config.yml", "id: legacy-id\n");
    fs.seed("/p/.claudebox/secrets.env", "X=1\n");
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), new InMemoryColima()).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("config.yml:        /p/.claudebox/config.yml");
    expect(out).toContain("secrets.env:       /p/.claudebox/secrets.env");
  });

  test("image labels rendered via the Docker fake (VMs-down state)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p"), new InMemoryColima()).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("image (cb-infra):  unavailable");
    expect(out).toContain("image (project):   unavailable");
  });
});

import { test, expect, describe } from "bun:test";
import { InfoCommand } from "./InfoCommand.ts";
import { InMemoryFileSystem } from "../../test/fakes/InMemoryFileSystem.ts";
import { InMemoryDocker } from "../../test/fakes/InMemoryDocker.ts";
import { StubGitToplevel } from "../../test/fakes/StubGitToplevel.ts";
import { StringWriter } from "../Context.ts";
import type { Context } from "../Context.ts";
import { EnvResolver } from "../../domain/EnvResolver.ts";
import { DRIDOCK_TS_VERSION } from "../../domain/dridockVersion.ts";

function makeCtx(fs: InMemoryFileSystem, cwd = "/p"): {
  ctx: Context; stdout: StringWriter;
} {
  const stdout = new StringWriter();
  return {
    stdout,
    ctx: {
      fs, env: new EnvResolver({}), cwd, home: "/home/alan", binName: "dridock",
      stdout, stderr: new StringWriter(),
    },
  };
}

describe("InfoCommand", () => {
  test("bare directory (no config.yml) prints the 'not a project yet' line", async () => {
    const fs = new InMemoryFileSystem();
    const docker = new InMemoryDocker();
    const { ctx, stdout } = makeCtx(fs, "/scratch");
    const rc = await new InfoCommand("info", "dridock:latest", docker, new StubGitToplevel("/scratch")).run([], ctx);
    expect(rc).toBe(0);
    const out = stdout.text();
    expect(out).toContain("dridock — info");
    expect(out).toContain(`wrapper (host):    ${DRIDOCK_TS_VERSION}`);
    expect(out).toContain("workspace:         /scratch");
    expect(out).toContain("not a dridock project yet");
    // No image (project) line when there's no id
    expect(out).not.toContain("image (project):");
  });

  test("full project prints VM name, config path, resolved data dir, and Phase 3 stubs for VM/network", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc12345\n");
    const docker = new InMemoryDocker();
    docker.seedImage("colima-cb-infra", "dridock:latest", "3.3.7");
    docker.seedImage("colima-cb-abc12345", "dridock:latest", "3.3.7");
    docker.seedClaudeCliVersion("colima-cb-abc12345", "dridock:latest", "0.5.14");
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("project id:        abc12345");
    expect(out).toContain("VM:                cb-abc12345");
    expect(out).toContain("config.yml:        /p/.dridock/config.yml");
    // Arfy #38 §🟠: baked claude CLI version row present (bash-parity)
    expect(out).toContain("claude CLI (image): 0.5.14");
    // Arfy #38 §🟠: data-dir path resolved to a real path, no literal token
    expect(out).toContain("/home/alan/.config/dridock/projects/abc12345/claude");
    expect(out).not.toContain("<XDG data dir>");
    // Phase 3 stubs are visible + labeled (audit rule: no silent drops).
    expect(out).toContain("VM status: Phase 3 stub");
    expect(out).toContain("container status: Phase 3 stub");
    expect(out).toContain("network:             (Phase 3 stub");
    expect(out).toContain("machine:             (Phase 3 stub");
  });

  test("data-dir path honors machine-config data_root override (~ expansion works)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    // Machine config sets a custom data_root
    fs.seed("/home/alan/.config/dridock/config.yml", "data_root: ~/custom-data\n");
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run([], ctx);
    expect(stdout.text()).toContain("/home/alan/custom-data/abc/claude");
  });

  test("secrets.env row: absent -> hint; present -> count keys", async () => {
    // Absent
    const fs1 = new InMemoryFileSystem();
    fs1.seed("/p/.dridock/config.yml", "id: abc\n");
    const { ctx: c1, stdout: s1 } = makeCtx(fs1);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run([], c1);
    expect(s1.text()).toContain("secrets.env:       (none");

    // Present with 3 keys (one comment, one blank line, one malformed — should not count)
    const fs2 = new InMemoryFileSystem();
    fs2.seed("/p/.dridock/config.yml", "id: abc\n");
    fs2.seed("/p/.dridock/secrets.env", [
      "GH_TOKEN=ghp_abc",
      "# comment line",
      "",
      "OPENAI_KEY=sk-xyz",
      "not-a-key",
      "ANTHROPIC_KEY=sk-abc",
    ].join("\n") + "\n");
    const { ctx: c2, stdout: s2 } = makeCtx(fs2);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run([], c2);
    expect(s2.text()).toContain("secrets.env:       /p/.dridock/secrets.env   (3 key(s))");
  });

  test("legacy .claudebox project: paths resolve to the legacy dot dir", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/p/.claudebox");
    fs.seed("/p/.claudebox/config.yml", "id: legacy-id\n");
    fs.seed("/p/.claudebox/secrets.env", "GH_TOKEN=abc\n");
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", new InMemoryDocker(), new StubGitToplevel("/p")).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("config.yml:        /p/.claudebox/config.yml");
    expect(out).toContain("secrets.env:       /p/.claudebox/secrets.env   (1 key(s))");
  });

  test("image labels rendered via the Docker fake — respects VMs-down state", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/p/.dridock/config.yml", "id: abc\n");
    const docker = new InMemoryDocker(); // nothing seeded -> IMAGE_UNAVAILABLE
    const { ctx, stdout } = makeCtx(fs);
    await new InfoCommand("info", "dridock:latest", docker, new StubGitToplevel("/p")).run([], ctx);
    const out = stdout.text();
    expect(out).toContain("image (cb-infra):  unavailable");
    expect(out).toContain("image (project):   unavailable");
  });
});

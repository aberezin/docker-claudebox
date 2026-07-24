import { test, expect, describe } from "bun:test";
import { AuthSecretsProvisioner } from "./AuthSecretsProvisioner.ts";
import { SidecarWriter } from "./SidecarWriter.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";

function makeProvisioner(env: Record<string, string | undefined>): {
  fs: InMemoryFileSystem; prov: AuthSecretsProvisioner;
} {
  const fs = new InMemoryFileSystem();
  const sidecars = new SidecarWriter(fs, "/data", "claude-_p");
  const prov = new AuthSecretsProvisioner(fs, sidecars, env, "/data");
  return { fs, prov };
}

describe("AuthSecretsProvisioner.writeAuthSidecars", () => {
  test("writes both env values to all three role sidecars, chmod 600", async () => {
    const { fs, prov } = makeProvisioner({
      ANTHROPIC_API_KEY: "sk-ant-abc",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz",
    });
    await prov.writeAuthSidecars();
    for (const suffix of ["", "_prog", "_cron"]) {
      const path = `/data/.claude-_p${suffix}-auth`;
      expect(await fs.readText(path)).toBe(
        "ANTHROPIC_API_KEY=sk-ant-abc\nCLAUDE_CODE_OAUTH_TOKEN=oauth-xyz\n",
      );
      expect(fs.modeOf(path)).toBe(0o600);
    }
  });

  test("empty env values still write empty sidecars (bash behavior — Never leave stale prior-run tokens)", async () => {
    const { fs, prov } = makeProvisioner({});
    await prov.writeAuthSidecars();
    for (const suffix of ["", "_prog", "_cron"]) {
      const path = `/data/.claude-_p${suffix}-auth`;
      expect(await fs.readText(path)).toBe(
        "ANTHROPIC_API_KEY=\nCLAUDE_CODE_OAUTH_TOKEN=\n",
      );
    }
  });

  test("DRIDOCK_NO_API_KEY=1 blanks the API key field (opt-out per wrapper.sh USEFUL ENV)", async () => {
    const { fs, prov } = makeProvisioner({
      ANTHROPIC_API_KEY: "sk-ant-abc",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz",
      DRIDOCK_NO_API_KEY: "1",
    });
    await prov.writeAuthSidecars();
    expect(await fs.readText("/data/.claude-_p_prog-auth")).toBe(
      "ANTHROPIC_API_KEY=\nCLAUDE_CODE_OAUTH_TOKEN=oauth-xyz\n",
    );
  });

  test("DRIDOCK_NO_OAUTH_TOKEN=1 blanks the OAuth token field", async () => {
    const { fs, prov } = makeProvisioner({
      ANTHROPIC_API_KEY: "sk-ant-abc",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-xyz",
      DRIDOCK_NO_OAUTH_TOKEN: "1",
    });
    await prov.writeAuthSidecars();
    expect(await fs.readText("/data/.claude-_p_prog-auth")).toBe(
      "ANTHROPIC_API_KEY=sk-ant-abc\nCLAUDE_CODE_OAUTH_TOKEN=\n",
    );
  });

  test("legacy CLAUDEBOX_NO_API_KEY still honored for one deprecation cycle", async () => {
    const { fs, prov } = makeProvisioner({
      ANTHROPIC_API_KEY: "sk-ant-abc",
      CLAUDEBOX_NO_API_KEY: "true",
    });
    await prov.writeAuthSidecars();
    expect(await fs.readText("/data/.claude-_p_prog-auth")).toContain("ANTHROPIC_API_KEY=\n");
  });

  test("only 'truthy' values (1/true/yes/on) trigger the opt-out — random strings don't", async () => {
    const { fs, prov } = makeProvisioner({
      ANTHROPIC_API_KEY: "sk-abc",
      DRIDOCK_NO_API_KEY: "no",   // NOT truthy
    });
    await prov.writeAuthSidecars();
    expect(await fs.readText("/data/.claude-_p_prog-auth")).toContain("ANTHROPIC_API_KEY=sk-abc\n");
  });
});

describe("AuthSecretsProvisioner.writeSecretsSidecars", () => {
  test("copies source file verbatim to all three role sidecars, chmod 600", async () => {
    const { fs, prov } = makeProvisioner({});
    fs.seed("/p/.dridock/secrets.env", "GH_TOKEN=ghp_abc\nOPENAI_KEY=sk-xyz\n", { mode: 0o600 });
    await prov.writeSecretsSidecars("/p/.dridock/secrets.env");
    for (const suffix of ["", "_prog", "_cron"]) {
      const path = `/data/.claude-_p${suffix}-secrets`;
      expect(await fs.readText(path)).toBe("GH_TOKEN=ghp_abc\nOPENAI_KEY=sk-xyz\n");
      expect(fs.modeOf(path)).toBe(0o600);
    }
  });

  test("no source file → NO sidecars written (bash: 'if [ -f $SECRETS_SRC ]')", async () => {
    const { fs, prov } = makeProvisioner({});
    const beforeCount = fs.recordedWrites.length;
    await prov.writeSecretsSidecars("/p/.dridock/secrets.env");
    expect(fs.recordedWrites.length).toBe(beforeCount);
  });

  test("empty source file → all three roles get empty sidecars (bash cp of empty file)", async () => {
    const { fs, prov } = makeProvisioner({});
    fs.seed("/p/.dridock/secrets.env", "", { mode: 0o600 });
    await prov.writeSecretsSidecars("/p/.dridock/secrets.env");
    expect(await fs.readText("/data/.claude-_p_prog-secrets")).toBe("");
  });
});

describe("AuthSecretsProvisioner.writeFeaturesSidecar", () => {
  test("non-empty list → `.features` written with space-separated names, chmod 644, legacy `.profiles` removed", async () => {
    const { fs, prov } = makeProvisioner({});
    fs.seed("/data/.profiles", "old typescript\n");   // legacy file exists
    await prov.writeFeaturesSidecar(["typescript", "python"]);
    expect(await fs.readText("/data/.features")).toBe("typescript python\n");
    expect(fs.modeOf("/data/.features")).toBe(0o644);
    expect(await fs.exists("/data/.profiles")).toBe(false);
  });

  test("empty list → both `.features` AND `.profiles` removed (bash rm -f)", async () => {
    const { fs, prov } = makeProvisioner({});
    fs.seed("/data/.features", "typescript\n");
    fs.seed("/data/.profiles", "typescript\n");
    await prov.writeFeaturesSidecar([]);
    expect(await fs.exists("/data/.features")).toBe(false);
    expect(await fs.exists("/data/.profiles")).toBe(false);
  });

  test("empty list on a project that has neither → no-op, no throw", async () => {
    const { prov } = makeProvisioner({});
    await prov.writeFeaturesSidecar([]);   // idempotent — nothing to remove
  });
});

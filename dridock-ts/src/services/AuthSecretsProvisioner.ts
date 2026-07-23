import type { FileSystem } from "../infra/FileSystem.ts";
import type { SidecarWriter } from "./SidecarWriter.ts";
import { SidecarWriter as _SidecarWriter } from "./SidecarWriter.ts";

void _SidecarWriter; // re-export type for downstream usage

/**
 * Writes the auth + secrets + features sidecars every run. This is
 * the standalone-`start` gate — without these files present under the
 * mounted data dir, the container boots without auth and rejects with
 * "Not logged in", and without secrets nothing the user put in
 * `.dridock/secrets.env` reaches the claudebot. Ports wrapper.sh:2964
 * (auth), :2977 (secrets), :2995 (features sidecar).
 *
 * These are the P0 items Arfy caught in the #38 stub inventory —
 * they were the whole reason her pass-6 test worked only because bash
 * had pre-provisioned the files.
 */
export class AuthSecretsProvisioner {
  constructor(
    private readonly fs: FileSystem,
    private readonly sidecars: SidecarWriter,
    private readonly env: Record<string, string | undefined>,
    private readonly dataDir: string,
  ) {}

  /**
   * Write the two auth-token env vars (empty when unset) to every role's
   * `-auth` sidecar. Ports wrapper.sh:2964-2970 exactly:
   *   ANTHROPIC_API_KEY=<value or empty>
   *   CLAUDE_CODE_OAUTH_TOKEN=<value or empty>
   *
   * Non-secret comment: values are ONLY on disk (chmod 600 via SidecarWriter),
   * NEVER on the `docker run` command line — bash's comment at :2979 spells
   * out why: values on argv leak into `ps` output.
   */
  async writeAuthSidecars(): Promise<void> {
    // DRIDOCK_NO_API_KEY / DRIDOCK_NO_OAUTH_TOKEN opt-outs — user
    // deliberately doesn't want a specific token forwarded. Bash reads
    // these at wrapper.sh:2277-2278; empty-out the field but still write
    // the sidecar so a prior run's token doesn't leak.
    const anthropicKey = truthy(this.env["DRIDOCK_NO_API_KEY"] ?? this.env["CLAUDEBOX_NO_API_KEY"] ?? this.env["CLAUDE_NO_API_KEY"])
      ? "" : (this.env["ANTHROPIC_API_KEY"] ?? "");
    const oauthToken = truthy(this.env["DRIDOCK_NO_OAUTH_TOKEN"] ?? this.env["CLAUDEBOX_NO_OAUTH_TOKEN"] ?? this.env["CLAUDE_NO_OAUTH_TOKEN"])
      ? "" : (this.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "");
    const content = `ANTHROPIC_API_KEY=${anthropicKey}\nCLAUDE_CODE_OAUTH_TOKEN=${oauthToken}\n`;
    await this.sidecars.writeAllRoles("auth", content);
  }

  /**
   * Copy the project's `.dridock/secrets.env` (or legacy
   * `.claudebox/secrets.env`) into every role's `-secrets` sidecar. No-op
   * when the source file doesn't exist. Ports wrapper.sh:2977-2987.
   */
  async writeSecretsSidecars(secretsSrcPath: string): Promise<void> {
    const text = await this.fs.readTextOrUndefined(secretsSrcPath);
    if (text === undefined) return; // matches bash's `if [ -f "$SECRETS_SRC" ]`
    await this.sidecars.writeAllRoles("secrets", text);
  }

  /**
   * Write the enabled features list to `<dataDir>/.features` — the
   * entrypoint reads this to know which per-feature install scripts to
   * run. Empty list → remove the sidecar (matches wrapper.sh:2995-3002).
   * Legacy `.profiles` sidecar is also removed so a 3.0 upgrade doesn't
   * leave stale content.
   */
  async writeFeaturesSidecar(features: readonly string[]): Promise<void> {
    const featuresPath = `${this.dataDir}/.features`;
    const legacyProfilesPath = `${this.dataDir}/.profiles`;
    if (features.length > 0) {
      await this.fs.writeText(featuresPath, features.join(" ") + "\n", { mode: 0o644 });
      await this.fs.removeFile(legacyProfilesPath);
    } else {
      await this.fs.removeFile(featuresPath);
      await this.fs.removeFile(legacyProfilesPath);
    }
  }
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

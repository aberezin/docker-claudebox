/**
 * `git config <key>` on the host — read-only. Ports the pieces of
 * wrapper.sh that populate DRIDOCK_GIT_NAME / DRIDOCK_GIT_EMAIL from the
 * host's git config so the claudebot's git commits carry the same
 * identity as the human's local ones.
 *
 * Kept as its own interface (not folded into GitToplevel) so the fake
 * can seed key→value without needing a full git repo.
 */
export interface HostGit {
  /** Value of `git config <key>` on the host, or undefined if unset. Never throws. */
  configGet(key: string): Promise<string | undefined>;
}

export class RealHostGit implements HostGit {
  async configGet(key: string): Promise<string | undefined> {
    try {
      // `git config <key>` — global search (default). Returns rc 1 with
      // empty stdout when the key is unset; we surface that as undefined.
      const proc = Bun.spawn(["git", "config", key], {
        stdout: "pipe", stderr: "ignore",
      });
      const text = (await new Response(proc.stdout).text()).trim();
      const rc = await proc.exited;
      if (rc !== 0 || text === "") return undefined;
      return text;
    } catch {
      return undefined;
    }
  }
}

/**
 * A "is-something-running" probe. Split out into an interface so the
 * state-dir migrator's live-Chrome guard is testable without spawning
 * real Chrome processes.
 *
 * Ports the pgrep call in cb_migrate_state_dirs's Defect A guard:
 *   `pgrep -f -- "--user-data-dir=$old"`
 */
export interface ProcessProbe {
  /** True if any running process's command line contains the exact
   *  substring `pattern`. Never throws; on tooling error (pgrep absent),
   *  returns false — the migrator falls back to "assume nothing's using
   *  it" which is the same behavior as macOS+Linux without pgrep. */
  processMatchingCmdline(pattern: string): Promise<boolean>;
}

export class RealProcessProbe implements ProcessProbe {
  async processMatchingCmdline(pattern: string): Promise<boolean> {
    try {
      // `pgrep -f -- "$pattern"` — matches the FULL command line, exact
      // substring (not regex; the -- guards against a pattern starting
      // with a dash being consumed as a flag). Exit 0 = matches found;
      // exit 1 = no match; anything else = tooling error.
      const proc = Bun.spawn(["pgrep", "-f", "--", pattern], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const rc = await proc.exited;
      return rc === 0;
    } catch {
      return false;
    }
  }
}

/** Test double — pre-seeded pattern → matching bool. */
export class StubProcessProbe implements ProcessProbe {
  private readonly matches = new Map<string, boolean>();
  seedMatch(pattern: string, matches: boolean): void { this.matches.set(pattern, matches); }
  async processMatchingCmdline(pattern: string): Promise<boolean> {
    return this.matches.get(pattern) ?? false;
  }
}

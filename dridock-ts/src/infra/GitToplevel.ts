/**
 * `git rev-parse --show-toplevel` — abstracted so unit tests don't need a
 * git binary or a real repo. Ports the toplevel-lookup half of
 * wrapper.sh's `cb_project_root`.
 */
export interface GitToplevel {
  /** Return absolute path of the git toplevel containing `cwd`, or
   *  undefined if `cwd` isn't in a repo (or git isn't available). Must
   *  never throw — the caller decides how to fall back. */
  topLevel(cwd: string): Promise<string | undefined>;
}

/** Production impl — shells out to `git`. */
export class RealGitToplevel implements GitToplevel {
  async topLevel(cwd: string): Promise<string | undefined> {
    try {
      // Bun.$ throws on non-zero exit; catch and return undefined for
      // the "not in a repo" case (rc 128). We check nothrow-mode instead
      // of try/catch churn for expected non-zero.
      const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      if (rc !== 0) return undefined;
      const top = text.trim();
      return top === "" ? undefined : top;
    } catch {
      return undefined;
    }
  }
}

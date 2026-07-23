/**
 * Run an arbitrary shell command on the host and capture its stdout. Used
 * by bootstrap's `--seed-secret KEY=CMD` (runs CMD, stores stdout as KEY)
 * and the `--adopt <url>` / `--repo <url>` clone paths.
 *
 * SECURITY: this is a wide-open interface — anything the user asks the
 * shell to run. The bash wrapper is the same shape (`$(eval "$_cmd")` via
 * `printf '%s\n' "$_cmd" | sh`). Callers must ONLY pass user-typed CMD
 * strings, never data from a config file / env / API.
 */
export interface HostCommandRunner {
  /** Run `sh -c <cmd>` and capture stdout. rc is the shell's exit code.
   *  stderr is inherited so the user sees real-time diagnostics. */
  runCapture(cmd: string): Promise<{ rc: number; stdout: string }>;
}

export class RealHostCommandRunner implements HostCommandRunner {
  async runCapture(cmd: string): Promise<{ rc: number; stdout: string }> {
    try {
      const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "inherit" });
      const stdout = await new Response(proc.stdout).text();
      const rc = await proc.exited;
      return { rc, stdout };
    } catch {
      return { rc: 1, stdout: "" };
    }
  }
}

/** Test double — pre-seeded cmd → outcome. */
export class StubHostCommandRunner implements HostCommandRunner {
  private readonly outcomes = new Map<string, { rc: number; stdout: string }>();
  readonly calls: string[] = [];
  seedCommand(cmd: string, rc: number, stdout: string): void {
    this.outcomes.set(cmd, { rc, stdout });
  }
  async runCapture(cmd: string): Promise<{ rc: number; stdout: string }> {
    this.calls.push(cmd);
    return this.outcomes.get(cmd) ?? { rc: 127, stdout: "" };
  }
}

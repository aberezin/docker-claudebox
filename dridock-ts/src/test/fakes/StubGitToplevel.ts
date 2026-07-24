import type { GitToplevel } from "../../infra/GitToplevel.ts";

/**
 * Test double: returns a fixed toplevel (or undefined for "not in a
 * repo"). Avoids invoking real `git` in unit tests.
 */
export class StubGitToplevel implements GitToplevel {
  constructor(private readonly result: string | undefined) {}
  async topLevel(_cwd: string): Promise<string | undefined> {
    return this.result;
  }
}

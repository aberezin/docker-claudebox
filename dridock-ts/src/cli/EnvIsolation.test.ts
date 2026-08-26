import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * #52 — production code must take environment from `ctx.env`, not the
 * ambient process.
 *
 * #51 fixed 17 XDG-adjacent sites; #52 swept the ~23 remaining ones in the
 * command layer plus two services. Neither would have stayed fixed: nothing
 * stopped the next command from typing `process.env[...]`, and no test
 * exercised those vars with a divergent env, so a regression was silent by
 * construction. This scans the source instead of trusting discipline.
 *
 * The two ALLOWED categories are narrow and deliberate:
 *
 *   - `cli/main.ts` — the composition root. Env has to enter somewhere;
 *     this is the one place, and it hands a Context to everything below.
 *   - `infra/*` — adapters that SPAWN CHILD PROCESSES. A child must inherit
 *     the real environment; substituting a test fake there would be wrong,
 *     not safer.
 */

const SRC = new URL("..", import.meta.url).pathname;
const ALLOWED_FILES = new Set(["cli/main.ts"]);
const ALLOWED_DIRS = ["infra/"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "test") continue;
      sourceFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Strip line comments and block-comment bodies — a mention of
 *  `process.env` in prose is documentation, not a leak. */
function codeLines(text: string): Array<{ n: number; line: string }> {
  const out: Array<{ n: number; line: string }> = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; return; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; return; }
    if (t.startsWith("//") || t.startsWith("*")) return;
    out.push({ n: i + 1, line });
  });
  return out;
}

describe("#52 — env comes from ctx, not the ambient process", () => {
  const files = sourceFiles(SRC);

  test("the scan actually found source files (guards a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  test("no production file outside the composition root and infra reads process.env", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC.length).replace(/^\/+/, "");
      if (ALLOWED_FILES.has(rel) || ALLOWED_DIRS.some((d) => rel.startsWith(d))) continue;
      for (const { n, line } of codeLines(readFileSync(file, "utf8"))) {
        if (line.includes("process.env")) offenders.push(`${rel}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the allowed sites are still real — the allowlist isn't quietly stale", () => {
    // If main.ts stops reading the environment, env is entering somewhere
    // else and this allowlist is hiding it.
    const main = readFileSync(join(SRC, "cli/main.ts"), "utf8");
    expect(main).toContain("new EnvResolver(process.env)");
  });
});

import { test, expect, describe } from "bun:test";
import { buildRegistry } from "./buildRegistry.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import type { Context } from "./Context.ts";

/**
 * #60 — the piece a CLI framework would NOT have given us.
 *
 * Before this, 11 of 27 command files mentioned `--help` at all, and a new
 * verb could ship with none while nothing noticed. Worse than absent help:
 * `dridock consult post --help` PERFORMED A SIDE EFFECT, creating a consult
 * thread literally named `--help` on disk, because the subverb parser took
 * the flag as its argument. Unhelpful help is an annoyance; help that writes
 * to disk is a bug.
 *
 * This iterates the REAL composition root (`buildRegistry`), not a
 * hand-maintained list, so a newly registered verb is covered the moment it
 * is wired up.
 */

function makeCtx(): { ctx: Context; out: string[]; err: string[]; fs: InMemoryFileSystem } {
  const out: string[] = [];
  const err: string[] = [];
  const fs = new InMemoryFileSystem();
  const ctx = {
    fs,
    env: new EnvResolver({}),
    stdout: { write: (s: string) => { out.push(s); } },
    stderr: { write: (s: string) => { err.push(s); } },
    home: "/home/tester",
    cwd: "/home/tester/proj",
    binName: "dridock",
  } as unknown as Context;
  return { ctx, out, err, fs };
}

const registry = buildRegistry();
const commands = registry.all();

test("the registry is actually populated (guards a vacuous suite)", () => {
  expect(commands.length).toBeGreaterThan(20);
});

describe("#60 — every registered verb answers --help", () => {
  for (const cmd of commands) {
    for (const flag of ["--help", "-h"]) {
      test(`${cmd.verb} ${flag}`, async () => {
        const { ctx, out, fs } = makeCtx();
        const before = fs.allPaths();
        const rc = await registry.dispatch([cmd.verb, flag], ctx);

        expect(rc).toBe(0);
        // Non-empty, and on STDOUT — help is the requested output, not a
        // diagnostic. Piping `dridock <verb> --help` to a pager must work.
        const text = out.join("");
        expect(text.trim().length).toBeGreaterThan(0);
        // It must actually describe THIS verb, not print a generic banner.
        expect(text).toContain(cmd.verb);
        // And it must not touch the filesystem. This is the assertion that
        // would have caught `consult post --help` writing a thread dir.
        expect(fs.allPaths()).toEqual(before);
      });
    }
  }
});

describe("#60 — declared subverbs answer --help without side effects", () => {
  for (const cmd of commands) {
    for (const sub of cmd.subverbs ?? []) {
      test(`${cmd.verb} ${sub.name} --help`, async () => {
        const { ctx, out, fs } = makeCtx();
        const before = fs.allPaths();
        const rc = await registry.dispatch([cmd.verb, sub.name, "--help"], ctx);

        expect(rc).toBe(0);
        expect(out.join("").trim().length).toBeGreaterThan(0);
        expect(out.join("")).toContain(sub.name);
        expect(fs.allPaths()).toEqual(before);
      });
    }
  }
});

test("usage text is a real synopsis, not a placeholder", () => {
  for (const cmd of commands) {
    expect(cmd.usage.trim().length).toBeGreaterThan(10);
    expect(cmd.usage).toContain("dridock");
  }
});

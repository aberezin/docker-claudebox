/**
 * dridock-ts CLI entry point.
 *
 * Composition root: wires production adapters (RealFileSystem, real
 * process.env) into a Context, registers every ported Command with the
 * Registry, dispatches, translates any DridockError to a typed exit code +
 * user-facing stderr message. No throws escape.
 *
 * Bash equivalent: the top of wrapper.sh through the main dispatch case.
 * ~3300 lines in bash; this is the entire entry point.
 */
import { basename } from "node:path";
import { CommandRegistry } from "./CommandRegistry.ts";
import { VersionCommand } from "./commands/VersionCommand.ts";
import { ConsultCommand } from "./commands/ConsultCommand.ts";
import { FeaturesCommand } from "./commands/FeaturesCommand.ts";
import { CheckversionCommand } from "./commands/CheckversionCommand.ts";
import { InfoCommand } from "./commands/InfoCommand.ts";
import { MigrateCommand } from "./commands/MigrateCommand.ts";
import { RealFileSystem } from "../infra/RealFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import { DridockError } from "../domain/errors.ts";
import type { Context, TextWriter } from "./Context.ts";

/** Adapts Node-compat `process.stdout` / `process.stderr` to the narrow
 *  TextWriter interface. Uses the Node-compat streams (not `Bun.stdout`
 *  which returns unresolved Promises) so that `process.exit(rc)` right
 *  after a `.write` doesn't drop buffered output — a real bug I hit on
 *  the first live smoke: `dridock-ts chrome` exited 1 but the error
 *  message was silently dropped. */
class ProcessStreamWriter implements TextWriter {
  constructor(private readonly stream: NodeJS.WriteStream) {}
  write(chunk: string): void { this.stream.write(chunk); }
}

function buildRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(new VersionCommand());
  registry.register(new ConsultCommand());
  registry.register(new FeaturesCommand("features"));
  registry.register(new FeaturesCommand("profiles"));
  registry.register(new CheckversionCommand());
  registry.register(new InfoCommand("info"));
  registry.register(new InfoCommand("status"));   // `status` is an alias of `info`
  registry.register(new MigrateCommand());
  // Additional verbs registered in later phases.
  return registry;
}

function resolveBinName(argv0: string): string {
  // Basename of the invoked binary — same as bash's $CB_SELF (added 3.2.3).
  // Preserves the "dridock" vs legacy "claudebox" symlink identity in
  // help/error text so `usage:` echoes match what the user typed. During
  // dev (`bun src/cli/main.ts …`) argv[0] is the bun binary path, so
  // basename returns "bun" — special-case that so the banner reads as
  // "dridock" during dev too. In the compiled binary, argv[0] is the
  // installed path and this branch never fires.
  const base = basename(argv0);
  if (base === "bun" || base.startsWith("bun-")) return "dridock";
  return base;
}

function buildContext(argv0: string): Context {
  return {
    fs: new RealFileSystem(),
    env: new EnvResolver(process.env),
    cwd: process.cwd(),
    home: process.env["HOME"] ?? "/",
    binName: resolveBinName(argv0),
    stdout: new ProcessStreamWriter(process.stdout),
    stderr: new ProcessStreamWriter(process.stderr),
  };
}

async function main(): Promise<number> {
  // process.argv: ['/path/to/bun', '/path/to/main.ts', ...userArgs]
  // — in the compiled binary it becomes ['/path/to/dridock', ...userArgs].
  // Basename of argv[0] gives us the binary name either way.
  const binaryArg = process.argv[0] ?? "dridock";
  const userArgs = process.argv.slice(2);   // matches Node/Bun convention

  const registry = buildRegistry();
  const ctx = buildContext(binaryArg);

  try {
    return await registry.dispatch(userArgs, ctx);
  } catch (err) {
    if (err instanceof DridockError) {
      ctx.stderr.write(`❌ ${err.message}\n`);
      return err.exitCode;
    }
    // Unexpected error — surface the stack so it's diagnosable, then exit
    // with an unambiguous "wrapper crashed" code (99, distinct from user error
    // 1 and env error 2).
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    ctx.stderr.write(`💥 dridock-ts crashed unexpectedly:\n${message}\n`);
    return 99;
  }
}

// Bun-style: run + exit with the returned code. Top-level await is fine here.
const exitCode = await main();
process.exit(exitCode);

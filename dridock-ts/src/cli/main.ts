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
import { DownCommand } from "./commands/DownCommand.ts";
import { DestroyCommand } from "./commands/DestroyCommand.ts";
import { StopCommand } from "./commands/StopCommand.ts";
import { StartCommand } from "./commands/StartCommand.ts";
import { VmCommand } from "./commands/VmCommand.ts";
import { IpCommand, NetCommand } from "./commands/IpNetCommand.ts";
import { DfCommand } from "./commands/DfCommand.ts";
import { CompletionCommand } from "./commands/CompletionCommand.ts";
import { FrameworkBugsCommand } from "./commands/FrameworkBugsCommand.ts";
import { ReportBugCommand } from "./commands/ReportBugCommand.ts";
import { ClearSessionCommand } from "./commands/ClearSessionCommand.ts";
import { SetupTokenCommand, DoctorCommand } from "./commands/ThrowawayCommands.ts";
import { McpCommand, AuthCommand } from "./commands/ProjectPassthroughCommand.ts";
import { HarnessCommand } from "./commands/HarnessCommand.ts";
import { BootstrapCommand } from "./commands/BootstrapCommand.ts";
import { BashDelegateCommand } from "./commands/BashDelegateCommand.ts";
import { ClaudeDirCommand } from "./commands/ClaudeDirCommand.ts";
import { CronModeCommand, cronModeRequested } from "./commands/CronModeCommand.ts";
import { HelpCommand } from "./commands/HelpCommand.ts";
import { RealFileSystem } from "../infra/RealFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import { DridockError } from "../domain/errors.ts";
import { RealProcessProbe } from "../infra/ProcessProbe.ts";
import { RealClock } from "../infra/Clock.ts";
import { RealGitToplevel } from "../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../services/ProjectRoot.ts";
import { autoMigrateIfNeeded } from "../services/AutoMigrate.ts";
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
  registry.register(new DownCommand());
  registry.register(new DestroyCommand());
  registry.register(new StopCommand());
  registry.register(new StartCommand());
  registry.register(new VmCommand());
  registry.register(new IpCommand());
  registry.register(new NetCommand());
  registry.register(new DfCommand());
  registry.register(new CompletionCommand());
  registry.register(new FrameworkBugsCommand());
  registry.register(new ReportBugCommand());
  registry.register(new ClearSessionCommand());
  registry.register(new SetupTokenCommand());
  registry.register(new DoctorCommand());
  registry.register(new AuthCommand());
  registry.register(new McpCommand());
  registry.register(new HarnessCommand());
  registry.register(new BootstrapCommand());
  // P4e transparent delegates (Python daemons untouched; only the bash
  // orchestration layer is being reused). See
  // project_ts_browserbridge_hostagent_full_port_todo memory for the
  // eventual full-TS port.
  registry.register(new BashDelegateCommand("browser-bridge"));
  registry.register(new BashDelegateCommand("host-agent"));
  // claude-dir was a bash-delegate through 3.3.7; ported inline 2026-07-24
  // to unblock bash-wrapper retirement step 3 (deleting wrapper.sh).
  registry.register(new ClaudeDirCommand());
  registry.register(new HelpCommand());
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
    // Auto-migrate: legacy `.claudebox/`-only project → `.dridock/`. Ports
    // cb_auto_migrate at wrapper.sh:2105. Silent no-op when: opt-out env
    // set, .claudebox absent, or .dridock already present. Runs BEFORE
    // dispatch so verbs read from the correct dot dir.
    const fs = new RealFileSystem();
    const project = await new ProjectRootResolver(fs, new RealGitToplevel()).resolve(ctx.cwd);
    await autoMigrateIfNeeded(project.root, {
      fs, probe: new RealProcessProbe(), clock: new RealClock(),
      env: process.env, home: ctx.home,
      onNotice: (m) => ctx.stderr.write(m),
    });

    // Cron mode intercept — bash triggers on DRIDOCK_MODE_CRON regardless
    // of the first positional arg (wrapper.sh:3070), so this MUST run
    // before verb dispatch. `stop` becomes "stop the cron container",
    // anything else spawns / resumes the detached _cron container.
    if (cronModeRequested(process.env)) {
      return await new CronModeCommand().run(userArgs, ctx);
    }

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

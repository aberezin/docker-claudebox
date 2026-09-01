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
import { ClaudeDirCommand } from "./commands/ClaudeDirCommand.ts";
import { CronModeCommand, cronModeRequested } from "./commands/CronModeCommand.ts";
import { BrowserBridgeCommand } from "./commands/BrowserBridgeCommand.ts";
import { HostAgentCommand } from "./commands/HostAgentCommand.ts";
import { TeamCommand } from "./commands/TeamCommand.ts";
import { HelpCommand } from "./commands/HelpCommand.ts";
import { findNoDridockMarker, formatNoDridockRefusal, shouldCheckNoDridock } from "../services/NoDridockGuard.ts";
import { RealFileSystem } from "../infra/RealFileSystem.ts";
import { EnvResolver } from "../domain/EnvResolver.ts";
import { DridockError } from "../domain/errors.ts";
import { RealProcessProbe } from "../infra/ProcessProbe.ts";
import { RealClock } from "../infra/Clock.ts";
import { RealGitToplevel } from "../infra/GitToplevel.ts";
import { ProjectRootResolver } from "../services/ProjectRoot.ts";
import { autoMigrateIfNeeded } from "../services/AutoMigrate.ts";
import type { Context, TextWriter } from "./Context.ts";
import { buildRegistry } from "./buildRegistry.ts";

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
    // The composition root is the ONE place the real environment enters
    // (#52). Everything downstream takes it from ctx, so tests can supply a
    // divergent env without a developer's shell leaking into results.
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
    const fs = new RealFileSystem();

    // .nodridock opt-out — MUST run before any project-touching side
    // effect (auto-migrate reads/writes .dridock; cron/start spawn
    // containers). Fires for cron mode + any project-scoped verb; safe,
    // non-project verbs (help/version/completion/framework-bugs/consult/
    // report-bug) skip the check so users can `dridock help` from
    // anywhere including a marked-off tree.
    if (shouldCheckNoDridock(userArgs, ctx.env.raw())) {
      const marker = await findNoDridockMarker(fs, ctx.cwd, ctx.home);
      if (marker !== undefined) {
        const verbLabel = cronModeRequested(ctx.env.raw())
          ? "start"          // cron dispatch masquerades as start; own label for the message
          : (userArgs[0] ?? "start");
        for (const line of formatNoDridockRefusal(marker, verbLabel, ctx.binName)) {
          ctx.stderr.write(line);
        }
        return 1;
      }
    }

    // Auto-migrate: legacy `.claudebox/`-only project → `.dridock/`. Ports
    // cb_auto_migrate at wrapper.sh:2105. Silent no-op when: opt-out env
    // set, .claudebox absent, or .dridock already present. Runs BEFORE
    // dispatch so verbs read from the correct dot dir.
    const project = await new ProjectRootResolver(fs, new RealGitToplevel()).resolve(ctx.cwd);
    await autoMigrateIfNeeded(project.root, {
      fs, probe: new RealProcessProbe(), clock: new RealClock(),
      env: ctx.env.raw(), home: ctx.home,
      onNotice: (m) => ctx.stderr.write(m),
    });

    // 5.0.0: a project left on `.claudebox/` no longer works SILENTLY.
    //
    // Auto-migrate above is the bridge and still runs, so the common case is
    // converted before anyone notices. This fires only when the project is
    // STILL legacy afterwards — auto-migrate opted out via
    // DRIDOCK_NO_AUTO_MIGRATE, or it could not complete. Through 4.x that
    // state quietly kept working off the legacy paths; now it stops and says
    // what to run. `migrate` itself is exempt, or the fix would be
    // unreachable. The migrators stay until 6.0 — see docs/roadmap.md.
    const verb0 = userArgs[0];
    if (verb0 !== "migrate") {
      const after = await new ProjectRootResolver(fs, new RealGitToplevel()).resolve(ctx.cwd);
      if (after.dotName === ".claudebox") {
        ctx.stderr.write(`❌ ${after.root} still uses the legacy .claudebox/ layout.\n`);
        ctx.stderr.write(`   Support for it was removed in 5.0.0 — it is no longer read silently.\n`);
        ctx.stderr.write(`   Convert it:  ${ctx.binName} migrate\n`);
        ctx.stderr.write(`   (The migration path itself is removed in 6.0.0 — see docs/roadmap.md.)\n`);
        return 1;
      }
    }

    // Cron mode intercept — bash triggers on DRIDOCK_MODE_CRON regardless
    // of the first positional arg (wrapper.sh:3070), so this MUST run
    // before verb dispatch. `stop` becomes "stop the cron container",
    // anything else spawns / resumes the detached _cron container.
    if (cronModeRequested(ctx.env.raw())) {
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

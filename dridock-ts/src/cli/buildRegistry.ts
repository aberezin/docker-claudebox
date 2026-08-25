/**
 * Composition root for the command registry.
 *
 * Split out of `main.ts` for #60: `main.ts` ends with a top-level
 * `await main(); process.exit(...)`, so ANY import of it runs the whole CLI.
 * The help-conformance test needs the real registry without launching
 * dridock, and a test that has to fake up its own registry would drift from
 * what actually ships — which is the exact failure mode it exists to catch.
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

/** Exported for the #60 help-conformance test, which asserts every
 *  REGISTERED command answers `--help` — the real composition root, not a
 *  hand-maintained list that could drift from it. */
export function buildRegistry(): CommandRegistry {
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
  // Native TS implementations (2026-07-24) of the last three verbs that
  // used to be BashDelegates through 3.4.0. Python daemons underneath
  // (browser-bridge's forward.py + host-agent.py) are unchanged; only
  // the bash *orchestration* around them ported. wrapper.sh retirement
  // is now unblocked on the bash-side (bash still ships these until
  // the deletion cycle).
  registry.register(new BrowserBridgeCommand());
  registry.register(new HostAgentCommand());
  registry.register(new ClaudeDirCommand());
  registry.register(new TeamCommand());
  registry.register(new HelpCommand());
  return registry;
}

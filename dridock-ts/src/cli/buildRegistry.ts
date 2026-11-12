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
import { PluginsCommand } from "./commands/PluginsCommand.ts";
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
import { resolveImage, type ImageChoice } from "../domain/ImageRef.ts";

/** Exported for the #60 help-conformance test, which asserts every
 *  REGISTERED command answers `--help` — the real composition root, not a
 *  hand-maintained list that could drift from it. */
export function buildRegistry(
  /** Which claudebot image the image-using verbs run (#109). `main` resolves
   *  it once from ctx.env and prints its notes. The default is the no-env
   *  answer (`dridock:latest`) so tests never read the ambient process (#52). */
  choice: ImageChoice = resolveImage(new EnvResolver({})),
): CommandRegistry {
  const image = choice.image;
  const registry = new CommandRegistry();
  registry.register(new VersionCommand());
  registry.register(new ConsultCommand());
  registry.register(new FeaturesCommand("features", undefined, undefined, image));
  registry.register(new PluginsCommand());
  registry.register(new FeaturesCommand("profiles", undefined, undefined, image));
  registry.register(new CheckversionCommand(image, undefined, undefined, undefined, undefined, choice));
  registry.register(new InfoCommand("info", image));
  registry.register(new InfoCommand("status", image));   // `status` is an alias of `info`
  registry.register(new MigrateCommand());
  registry.register(new DownCommand());
  registry.register(new DestroyCommand());
  registry.register(new StopCommand());
  registry.register(new StartCommand(image, {}, choice.variant));
  registry.register(new VmCommand());
  registry.register(new IpCommand());
  registry.register(new NetCommand());
  registry.register(new DfCommand());
  registry.register(new CompletionCommand());
  registry.register(new FrameworkBugsCommand());
  registry.register(new ReportBugCommand());
  registry.register(new ClearSessionCommand());
  registry.register(new SetupTokenCommand(undefined, image));
  registry.register(new DoctorCommand(undefined, image));
  registry.register(new AuthCommand(image));
  registry.register(new McpCommand(image));
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

/** Cron mode is dispatched by env, not by verb, so it isn't registered; it is
 *  built here so the #109 wiring test covers it like every other image user. */
export function buildCronModeCommand(choice: ImageChoice = resolveImage(new EnvResolver({}))): CronModeCommand {
  return new CronModeCommand(choice.image, {}, choice.variant);
}

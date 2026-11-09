import type { Command } from "../Command.ts";
import type { Context } from "../Context.ts";
import { DridockError } from "../../domain/errors.ts";
import { ProjectRootResolver } from "../../services/ProjectRoot.ts";
import {
  ProjectConfig,
  PLUGIN_SPEC_REGEX,
  legacyLocationNotice,
} from "../../services/ProjectConfig.ts";
import type { GitToplevel } from "../../infra/GitToplevel.ts";
import { RealGitToplevel } from "../../infra/GitToplevel.ts";

/**
 * `dridock plugins <verb>` — manage the project's Claude Code plugins (#97).
 *
 * #96 shipped the `plugins:` config key with no CLI verb at all, so the only
 * way to enable a plugin was hand-editing a gitignored file. This closes that
 * and writes to the tracked `.dridock/project.yml` instead, so a plugin set
 * arrives with a clone.
 *
 * Deliberately NO `info` sub-verb, unlike `features`: a feature's manifest is
 * baked into the image and readable offline with a `docker cat`, whereas a
 * plugin lives in a GitHub marketplace. "info" would mean a network fetch of
 * someone else's repo, which is a different kind of command — left out rather
 * than half-built.
 *
 * Installation itself is the entrypoint's job (`_install_project_plugins`),
 * driven off the `~/.claude/.plugins` sidecar that `start` writes. This verb
 * only edits config; nothing here reaches the container.
 */
export class PluginsCommand implements Command {
  readonly verb = "plugins";
  readonly usage = `dridock plugins [list|add|remove]

Manage this project's Claude Code plugins. Entries are written to
.dridock/project.yml, which is TRACKED — commit it and every clone of the
project gets the same plugin set. (Before #97 they went to the gitignored
config.yml, where they could not travel.)

A plugin spec is name@owner/repo, e.g. superpowers@aberezin/superpowers.
There is no version component: a marketplace tracks its HEAD, so a plugin
set cannot be pinned from config.

Installing is the container's job, at start, on top of the baked-in default
(commit-commands). DRIDOCK_DEFAULT_PLUGINS=0 opts out of everything.`;
  readonly subverbs = [
    { name: "list", synopsis: "dridock plugins list\n\nShow this project's plugins. Marks any still living in the gitignored config.yml." },
    { name: "add", synopsis: "dridock plugins add <name@owner/repo>\n\nAdd a plugin to .dridock/project.yml, creating that file if needed. Installs on the next start." },
    { name: "remove", synopsis: "dridock plugins remove <name@owner/repo>\n\nRemove a plugin from .dridock/project.yml (and from config.yml if it is still there). Does not uninstall an already-installed copy." },
  ] as const;

  constructor(private readonly gitOverride?: GitToplevel) {}

  async run(args: readonly string[], ctx: Context): Promise<number> {
    const sub = args[0] ?? "list";
    if (sub === "list" || sub === "") return await this.list(ctx);
    if (sub === "-h" || sub === "--help") { this.printHelp(ctx); return 0; }
    if (sub === "add") return await this.add(args[1], ctx);
    if (sub === "remove") return await this.remove(args[1], ctx);
    throw new DridockError(`plugins: unknown sub-verb '${sub}' (try: ${ctx.binName} plugins --help)`);
  }

  private async list(ctx: Context): Promise<number> {
    const project = await this.resolveProject(ctx);
    const cfg = new ProjectConfig(ctx.fs);
    const resolved = await cfg.pluginsResolved(project.configPath, project.projectPath);

    ctx.stdout.write(`enabled for this project (${project.dotName}/project.yml → plugins:):\n`);
    if (resolved.values.length > 0) {
      for (const p of resolved.values) {
        const where = resolved.legacy.includes(p) ? "  (config.yml — local only)" : "";
        ctx.stdout.write(`  ${p}${where}\n`);
      }
    } else {
      ctx.stdout.write(`  (none — run '${ctx.binName} plugins add superpowers@aberezin/superpowers')\n`);
    }
    if (resolved.legacy.length > 0) {
      ctx.stderr.write(legacyLocationNotice("plugins", resolved.legacy, project.dotName));
    }
    ctx.stdout.write(`\n`);
    ctx.stdout.write(`These install on first container start, on TOP of the hardcoded default\n`);
    ctx.stdout.write(`(commit-commands). DRIDOCK_DEFAULT_PLUGINS=0 opts out of everything.\n`);
    return 0;
  }

  private async add(spec: string | undefined, ctx: Context): Promise<number> {
    if (spec === undefined || spec === "") {
      ctx.stderr.write(`usage: ${ctx.binName} plugins add <name@owner/repo>\n`);
      return 1;
    }
    // Same regex the parser uses — see PLUGIN_SPEC_REGEX on why that matters.
    if (!PLUGIN_SPEC_REGEX.test(spec)) {
      ctx.stderr.write(`plugins add: bad spec '${spec}'\n`);
      ctx.stderr.write(`  expected name@owner/repo, chars [A-Za-z0-9._-] per segment\n`);
      ctx.stderr.write(`  e.g. superpowers@aberezin/superpowers\n`);
      ctx.stderr.write(`  (there is no version component — a marketplace tracks its HEAD)\n`);
      return 1;
    }
    const project = await this.resolveProject(ctx);
    const cfg = new ProjectConfig(ctx.fs);
    const resolved = await cfg.pluginsResolved(project.configPath, project.projectPath);
    if (resolved.values.includes(spec)) {
      ctx.stdout.write(`  ✓ ${spec} already enabled\n`);
      return 0;
    }
    const inProject = await cfg.plugins(project.projectPath);
    const next = [...inProject, spec];
    await cfg.setProjectList(project.projectPath, "plugins", next);
    ctx.stdout.write(`  ✓ added plugin '${spec}' to ${project.dotName}/project.yml\n`);
    ctx.stdout.write(`    installs on the next '${ctx.binName}' start (marker-guarded, retried if offline).\n`);
    ctx.stdout.write(`    ${project.dotName}/project.yml is tracked — commit it so every clone gets this.\n`);
    return 0;
  }

  private async remove(spec: string | undefined, ctx: Context): Promise<number> {
    if (spec === undefined || spec === "") {
      ctx.stderr.write(`usage: ${ctx.binName} plugins remove <name@owner/repo>\n`);
      return 1;
    }
    const project = await this.resolveProject(ctx);
    const cfg = new ProjectConfig(ctx.fs);
    const resolved = await cfg.pluginsResolved(project.configPath, project.projectPath);
    if (!resolved.values.includes(spec)) {
      ctx.stdout.write(`  ℹ ${spec} isn't in plugins: — nothing to remove\n`);
      return 0;
    }
    // Remove from BOTH files: reads are a union, so clearing only project.yml
    // would leave a config.yml copy still installing it while reporting
    // success.
    const inProject = await cfg.plugins(project.projectPath);
    if (inProject.includes(spec)) {
      await cfg.setProjectList(project.projectPath, "plugins", inProject.filter((p) => p !== spec));
    }
    if (resolved.legacy.includes(spec)) {
      const inConfig = await cfg.plugins(project.configPath);
      await cfg.setExistingList(project.configPath, "plugins", inConfig.filter((p) => p !== spec));
    }
    const remaining = resolved.values.filter((p) => p !== spec);
    const hint = remaining.length > 0 ? ` (remaining: ${remaining.join(", ")})` : "";
    ctx.stdout.write(`  ✓ removed plugin '${spec}'${hint}\n`);
    // Honest about what this does NOT do: the config no longer asks for it,
    // but an already-installed plugin stays installed in that container.
    ctx.stdout.write(`    note: already-installed copies stay until you run 'claude plugin uninstall ${spec.split("@")[0]}' in the container.\n`);
    return 0;
  }

  private async resolveProject(ctx: Context) {
    const git = this.gitOverride ?? new RealGitToplevel();
    return await new ProjectRootResolver(ctx.fs, git).resolve(ctx.cwd);
  }

  private printHelp(ctx: Context): void {
    ctx.stdout.write(`usage: ${ctx.binName} plugins [list | add <name@owner/repo> | remove <name@owner/repo>]\n`);
    ctx.stdout.write(`  list                    show this project's plugins (default)\n`);
    ctx.stdout.write(`  add <spec>              add to plugins: in .dridock/project.yml (tracked — commit it)\n`);
    ctx.stdout.write(`  remove <spec>           remove from plugins:\n\n`);
    ctx.stdout.write(`  <spec> is name@owner/repo, e.g. superpowers@aberezin/superpowers.\n`);
    ctx.stdout.write(`  Plugins install at container start, on top of the baked-in default.\n`);
    ctx.stdout.write(`  Full design: docs/design/plugins-system.md · docs/design/project-config-split.md\n`);
  }
}

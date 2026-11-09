/**
 * The verb catalog — every top-level first-arg dridock knows how to handle.
 * Enumerated so the CLI dispatcher can reject unknown verbs at compile time
 * (via `keyof typeof VERBS`) AND at runtime with a typed error (matching
 * wrapper.sh:2766's 3.3.7 behavior).
 *
 * Bash version was 3300 lines of `case` branches with no shared source of
 * truth; add-a-verb meant hunting for the right insertion point + updating
 * completion + updating --help. Here: one entry per verb, all three surfaces
 * (dispatch / completion / --help) generated from this map.
 */

export type VerbClass =
  /** Read-only project introspection — no VM work, safe to run anywhere. */
  | "readonly"
  /** Runs the interactive claudebot in the project VM. */
  | "launch"
  /** Manages VM/project lifecycle — potentially destructive. */
  | "vm-mgmt"
  /** Manages project state (migrate, bootstrap, features). */
  | "state-mgmt"
  /** Cross-project framework-dev channels (consult, framework-bugs). */
  | "framework"
  /** Throwaway container passthrough (setup-token, doctor, auth, mcp). */
  | "throwaway"
  /** CLI meta (help, version). */
  | "meta";

export interface VerbSpec {
  readonly summary: string;
  readonly class: VerbClass;
  /** Subcommands the completion should offer (e.g. `vm ls|list|usage|df|gc`). */
  readonly subcommands?: readonly string[];
  /** True when the verb needs project state (VM/config); false when it can
   *  run anywhere. Guides whether the guard chain fires. */
  readonly needsProject: boolean;
}

/**
 * Every verb wrapper.sh handles today (post 3.3.7). Adding a verb: add one
 * entry here, add one class in `src/cli/commands/`, wire it in the composition
 * root of `main.ts`. That's it.
 */
export const VERBS = {
  start:            { summary: "start/attach the claudebot for $PWD",              class: "launch",       needsProject: true } as const,
  stop:             { summary: "stop the claudebot container (survives)",           class: "vm-mgmt",      needsProject: true } as const,
  down:             { summary: "stop the project's VM",                             class: "vm-mgmt",      needsProject: true } as const,
  destroy:          { summary: "destroy the project VM (workload goes with it)",    class: "vm-mgmt",      needsProject: true,  subcommands: ["--purge"] as const } as const,
  migrate:          { summary: "migrate legacy .claudebox → .dridock",              class: "state-mgmt",   needsProject: false, subcommands: ["--all"] as const } as const,
  bootstrap:        { summary: "scaffold a new project in $PWD",                    class: "state-mgmt",   needsProject: false } as const,
  info:             { summary: "human-facing project overview",                     class: "readonly",     needsProject: true } as const,
  status:           { summary: "alias of `info`",                                   class: "readonly",     needsProject: true } as const,
  version:          { summary: "print the wrapper's DRIDOCK_VERSION",               class: "meta",         needsProject: false } as const,
  checkversion:     { summary: "compare host wrapper against the image label",      class: "readonly",     needsProject: true,  subcommands: ["--all"] as const } as const,
  features:         { summary: "list / enable / disable / info the project's features", class: "state-mgmt", needsProject: true, subcommands: ["list", "enable", "disable", "info"] as const } as const,
  profiles:         { summary: "legacy 2.x alias of `features`",                    class: "state-mgmt",   needsProject: true,  subcommands: ["list", "enable", "disable", "info"] as const } as const,
  plugins:          { summary: "list / add / remove this project's Claude Code plugins", class: "state-mgmt", needsProject: true,  subcommands: ["list", "add", "remove"] as const } as const,
  vm:               { summary: "colima VM diagnostics",                             class: "vm-mgmt",      needsProject: false, subcommands: ["ls", "list", "usage", "df", "gc"] as const } as const,
  ip:               { summary: "print this project VM's reachable IP",              class: "readonly",     needsProject: true } as const,
  net:              { summary: "print the browse dashboard; with <name>, set network.hostname", class: "state-mgmt", needsProject: true } as const,
  "browser-bridge": { summary: "opt-in CDP bridge to your real Chrome",             class: "vm-mgmt",      needsProject: true,  subcommands: ["up", "down", "status"] as const } as const,
  "host-agent":     { summary: "framework-dev host-command proxy (TRUSTED)",        class: "vm-mgmt",      needsProject: false, subcommands: ["up", "down", "status"] as const } as const,
  harness:          { summary: "framework-dev-only: sync cb-infra image, bump CLI pin", class: "vm-mgmt",   needsProject: false, subcommands: ["sync", "update-cli"] as const } as const,
  "framework-bugs": { summary: "review cross-project framework bug reports",        class: "framework",    needsProject: false, subcommands: ["list", "clear"] as const } as const,
  consult:          { summary: "supervised claudebot ↔ framework-Claude threads",   class: "framework",    needsProject: false, subcommands: ["list", "show", "approve", "revise", "reject", "post", "watch"] as const } as const,
  "claude-dir":     { summary: "print this project's host .claude data dir",        class: "readonly",     needsProject: true } as const,
  completion:       { summary: "print bash completion script",                      class: "meta",         needsProject: false, subcommands: ["bash"] as const } as const,
  help:             { summary: "show full help",                                    class: "meta",         needsProject: false } as const,
  "setup-token":    { summary: "run `claude setup-token` in a throwaway container", class: "throwaway",    needsProject: false } as const,
  "clear-session":  { summary: "clear the claudebot's session (throwaway container)", class: "throwaway",  needsProject: false } as const,
  doctor:           { summary: "run `claude doctor` in a throwaway container",      class: "throwaway",    needsProject: false } as const,
  auth:             { summary: "run `claude auth …` in a throwaway container",      class: "throwaway",    needsProject: false } as const,
  mcp:              { summary: "run `claude mcp …` in a throwaway container",       class: "throwaway",    needsProject: false } as const,
  "report-bug":     { summary: "file a framework bug report",                       class: "framework",    needsProject: false } as const,
  df:               { summary: "at-a-glance VM disk usage",                         class: "readonly",     needsProject: false } as const,
  team:             { summary: "named-agent message bus over GitHub comments (agent-teams.md)", class: "state-mgmt", needsProject: true, subcommands: ["whoami", "roster", "post", "watch", "fetcher", "dir"] as const } as const,
} as const satisfies Record<string, VerbSpec>;

export type Verb = keyof typeof VERBS;

/** Type-safe check: is this string a known verb? */
export function isKnownVerb(v: string): v is Verb {
  return v in VERBS;
}

/** All verb names, sorted — for `--help` and completion output. */
export function allVerbNames(): readonly Verb[] {
  return Object.keys(VERBS).sort() as Verb[];
}

/**
 * Every verb that declares `subcommands`, sorted, as `[verb, subcommands]`.
 *
 * This exists so the bash-completion script is GENERATED from this map
 * instead of hand-written beside it. The header above has claimed since the
 * TS port that "all three surfaces (dispatch / completion / --help)" come
 * from here, but completion was a hardcoded `case` block in
 * CompletionCommand.ts, and it drifted exactly as you would expect: by
 * #101 it was missing `status` for browser-bridge, `update-cli` for
 * harness, and had no arm at all for `team` or `plugins` — so two verbs
 * simply didn't tab-complete. Generating it deletes that copy rather than
 * adding a test to watch it (#101).
 */
export function verbsWithSubcommands(): readonly (readonly [Verb, readonly string[]])[] {
  return allVerbNames()
    .map((v) => [v, (VERBS[v] as VerbSpec).subcommands] as const)
    .filter((pair): pair is readonly [Verb, readonly string[]] => pair[1] !== undefined);
}

/**
 * Subcommands that are really FLAGS, not subverbs — `destroy --purge`,
 * `migrate --all`. They belong in `subcommands` because completion should
 * offer them, but a `Command` must not declare them as `subverbs`: there is
 * no `dridock destroy --purge --help`. The #101 cross-check uses this to
 * compare only the subverb-shaped entries.
 */
export function isFlagShaped(subcommand: string): boolean {
  return subcommand.startsWith("-");
}

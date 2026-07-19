# Customization

- [Custom scripts (`~/.claude/bin`)](#custom-scripts-claudebin)
- [Init hooks (`~/.claude/init.d`)](#init-hooks-claudeinitd)
- [Always-active skills (`~/.claude/.always-skills`)](#always-active-skills-claudealways-skills)
- [MCP servers](#mcp-servers)

## Custom scripts (`~/.claude/bin`)

Any executable files placed in `~/.claude/bin/` are available on PATH inside every container session — interactive, programmatic, API, all modes.

```bash
mkdir -p ~/.claude/bin
echo '#!/bin/bash
echo "hello from custom script"' > ~/.claude/bin/my-tool
chmod +x ~/.claude/bin/my-tool
# my-tool is now available inside every dridock session
```

## Init hooks (`~/.claude/init.d`)

Scripts placed in `~/.claude/init.d/*.sh` run once when a container is first created. They execute as root before the entrypoint drops to the `claude` user. They do not re-run on subsequent `docker start` — only on fresh containers.

```bash
mkdir -p ~/.claude/init.d
cat > ~/.claude/init.d/setup.sh << 'EOF'
#!/bin/bash
apt-get update && apt-get install -y some-package
pip install some-library
EOF
chmod +x ~/.claude/init.d/setup.sh
```

This is particularly useful with the minimal image — pre-install your tools once on first run so Claude doesn't burn tokens and time running `apt-get` on every session.

## Profiles (opt-in tool bundles)

For **common** tooling — especially language servers — prefer **profiles** over a hand-written init.d hook. Add them to `.dridock/config.yml`:

```yaml
profiles: [typescript, python]   # run `dridock profiles` to list available ones
```

The harness ships curated installers (e.g. `typescript` / `python` / `go` enable the matching `*-lsp` plugin; their servers are baked into the image), installs each once on first enable, and re-checks on later runs so adding a profile doesn't need a fresh container. `init.d` remains the escape hatch for anything a profile doesn't cover. Full details, and how to add your own profile, in [design/profiles.md](design/profiles.md).

## Always-active skills (`~/.claude/.always-skills`)

Skill files placed in `~/.claude/.always-skills/` are automatically injected into the system prompt of every Claude invocation — interactive, programmatic, API, OpenAI adapter, MCP, Telegram, all of them. No slash commands, no per-request headers, no configuration needed.

Each subdirectory should contain a `SKILL.md` file with instructions for Claude. The directory is scanned recursively in alphabetical order, and every `SKILL.md` found is appended to the system prompt with a prefix showing its full file path:

```
[Skill file: /home/claude/.claude/.always-skills/caveman/SKILL.md]

<contents of the skill file>
```

The path prefix is included so Claude knows exactly where the skill lives on disk and can read any adjacent files referenced by the skill.

**Example: install the caveman skill to auto-activate every session:**

```bash
mkdir -p ~/.claude/.always-skills/caveman
cp ~/.claude/plugins/cache/caveman/caveman/*/skills/caveman/SKILL.md \
   ~/.claude/.always-skills/caveman/SKILL.md
```

**Example: write a custom skill:**

```bash
mkdir -p ~/.claude/.always-skills/my-rules
cat > ~/.claude/.always-skills/my-rules/SKILL.md << 'EOF'
When writing Go code, always use slog for structured logging, never fmt.Println.
When writing Python, always use pathlib for file paths, never os.path.
EOF
```

Multiple skills stack — every `SKILL.md` found is injected. Any user-supplied `appendSystemPrompt` (via API request body, `--append-system-prompt` CLI flag, `X-Claude-Append-System-Prompt` header, etc.) is appended after the always-skills content, so per-request instructions take precedence.

## MCP servers

Claude Code reads MCP server definitions from a few standard locations. Inside dridock, all of these work because `~/.claude` is mounted from the host and the workspace is mounted from the host cwd:

| Scope     | Path                                                  | Description                                                                          |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Project   | `<workspace>/.mcp.json`                               | Per-repo, intended to be checked into git so the team shares the same servers        |
| User      | `~/.claude.json` (under the `mcpServers` key)         | Global, available across every project on the host                                   |
| Local     | `~/.claude.json` (per-project section)                | Default scope of `claude mcp add`, only affects the current project, not shared      |

**File format** (same for `.mcp.json` and the `mcpServers` block inside `~/.claude.json`):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "API_KEY": "..." }
    },
    "remote-http": {
      "type": "http",
      "url": "https://example.com/mcp/"
    }
  }
}
```

**Add via CLI inside the container:**

```bash
# project scope — writes to ./.mcp.json in the workspace (commit-friendly)
dridock mcp add --scope project my-server -- npx -y @some/mcp-server

# user scope — writes to ~/.claude.json, available in every project
dridock mcp add --scope user my-server -- npx -y @some/mcp-server

# local scope (default) — per-project entry inside ~/.claude.json
dridock mcp add my-server -- npx -y @some/mcp-server
```

**Inspect what's loaded:** run `/mcp` inside an interactive session.

This is how cron and Telegram modes reach external systems — drop your server config in `.mcp.json` (project) or `~/.claude.json` (global) and reference it from the instruction.

## Plugins

Claude Code plugins bundle slash commands, agents, hooks, MCP servers, and skills, and are declared **non-interactively** in `settings.json` — no `/plugin` commands required. Two keys drive it: `extraKnownMarketplaces` (register a marketplace) and `enabledPlugins` (turn plugins on). The dridock entrypoint manages `.claude.json` but leaves `settings.json` to you, so it won't clobber your config.

### Baked default

On the **first interactive session** in a project, the entrypoint installs the official **`commit-commands`** plugin (git commit / push / PR workflows — language- and framework-agnostic) by running, as the `claude` user, the equivalent of:

```bash
claude plugin install commit-commands@claude-plugins-official --scope user
```

Why the CLI install and not just a `settings.json` file: declaring a plugin in `settings.json` (`extraKnownMarketplaces` + `enabledPlugins`) does **not** activate it on its own — Claude Code has to clone the marketplace and register the plugin, which only the install command does. So the entrypoint runs it once (it writes the same `settings.json` keys and clones the marketplace cache into the project's `.claude`).

It's deliberately scoped to be cheap and unobtrusive:

- **Interactive only** — skipped for daemon modes (API/Telegram/cron), programmatic (`-p`) runs, and `setup-token`, so it never delays a server start or an ephemeral/CI container.
- **Once per project** — a marker in the project's `.claude` is set after a successful install, so it runs at most once (a failed attempt, e.g. offline, retries on a later interactive session).
- **Best-effort + time-bounded** — if it can't reach GitHub it prints a note and moves on; it never blocks the session.

Opt out entirely with `DRIDOCK_DEFAULT_PLUGINS=0`. Remove it from a project with `claude plugin uninstall commit-commands@claude-plugins-official` — the one-shot marker means it won't be reinstalled.

### Specifying your own plugins — three scopes

`settings.json` (and thus plugin config) is read from, in order of precedence:

| Scope        | Path                                                | Use case                                                  |
| ------------ | --------------------------------------------------- | --------------------------------------------------------- |
| This project | `$(dridock claude-dir)/settings.json`               | just this claudebot (per-project host `.claude`, mounted) |
| Committed    | `<workspace>/.claude/settings.json`                 | versioned with the repo; travels with the project / team  |
| Every project | bake into the entrypoint (as the default above does) | one standard set across all claudebots                    |

To add a plugin, put its marketplace under `extraKnownMarketplaces` and enable it under `enabledPlugins` with the key `"<plugin-name>@<marketplace-key>"`. Make the marketplace **key match the marketplace's manifest `name`** to avoid resolution ambiguity (that's why the default uses `claude-plugins-official` for both). Plugins auto-load on the next run — their commands/agents/hooks/MCP servers/skills become available with no further steps.

**Interactive alternative:** run `dridock` and use `/plugin marketplace add <repo>` / `/plugin install <name>@<marketplace>`; it writes to the project's mounted `.claude`, so it persists.

**Note:** the plugin cache (`~/.claude/plugins/cache/`) is per-project, so the same plugin enabled across N projects is fetched N times. For a single shared standard, prefer the baked default (scope #3).

## See also

- [environment-variables.md](environment-variables.md) — the full env-var surface.
- [design/per-project-vm.md](design/per-project-vm.md) — per-project `~/.claude`, `init.d`, plugins.
- [design/convenience-scripts.md](design/convenience-scripts.md) — adding `cb-*` helpers.
- The top-level [`CLAUDE.md`](../CLAUDE.md).

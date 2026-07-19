# Interactive Mode

```bash
dridock
```

Works just like the native `claude` CLI but runs inside a container. The container persists between runs, and `--continue` is applied automatically so each session picks up where you left off.

```bash
dridock --update        # opt in to a Claude Code CLI update on this run
dridock --no-continue   # start a fresh session instead of resuming the last one
```

## Utility commands

Some commands are passed through directly without entering interactive mode:

```bash
dridock --version      # show the Claude Code CLI version
dridock -v             # same thing
dridock doctor         # run health checks
dridock auth           # manage authentication
dridock mcp <args...>  # manage MCP servers (e.g. `dridock mcp list`, `dridock mcp add ...`)
dridock setup-token    # interactive OAuth token setup
dridock stop           # stop the running interactive container for this workspace
dridock clear-session  # delete session history for this workspace
```

> In 2.x these were `claudebox <verb>`; the 2.x binary name is kept as a legacy alias during the deprecation cycle.

## See also

- [programmatic.md](programmatic.md) — non-interactive `-p` runs.
- [api.md](api.md) — the HTTP/OpenAI/MCP server.
- [environment-variables.md](../environment-variables.md) — auth and in-container env.
- The [README](../../README.md) — overview of all modes.

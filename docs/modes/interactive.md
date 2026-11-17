# Interactive Mode

```bash
dridock
```

Works just like the native `claude` CLI but runs inside a container. The container persists between runs, and `--continue` is applied automatically so each session picks up where you left off.

```bash
dridock --update        # opt in to a Claude Code CLI update on this run
dridock --no-continue   # start a fresh session instead of resuming the last one
dridock start --resume <session-id>   # resume a specific conversation (skips --continue)
```

If `--continue` fails, the session does **not** silently start fresh (#128). Claude's own
reason stays on screen, and dridock adds how to get the conversation back, as
`dridock start --resume <id>` with the id of the newest transcript for this workspace.
That can be a cron job's run rather than your conversation; `claude --resume` lists them all.

The known cause was a stale session registration: a session moved to the background
(for example with `--remote-control`) leaves one in `~/.claude/sessions/`, and after its
container is restarted or recreated, `--continue` skipped or refused that conversation as
"registered from another machine or container". It's now removed on start, before Claude
runs. That happens before the TUI takes the screen, so the line saying so is in
`docker logs <container>`, not on screen.

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

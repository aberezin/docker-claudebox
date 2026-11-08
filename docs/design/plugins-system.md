# Per-project Claude Code plugins

> **Status:** shipped in 5.9.0 (#96). Supersedes the hardcoded-install pattern
> that preceded it by making the plugin list per-project configuration.

Dridock projects can declare which Claude Code plugins their claudebot should
have installed. Same mechanism shape as [features](features-system.md), but a
different artifact: plugins are a Claude Code concept (skills + commands
packaged under `.claude-plugin/`), delivered through marketplaces; features are
a dridock concept (installer scripts that run `on.sh` on first container
create).

## Config

Declare plugins in `.dridock/config.yml` under `plugins:`, same flow/block YAML
shape features uses:

```yaml
# flow style:
plugins: [commit-commands@anthropics/claude-plugins-official, superpowers@aberezin/superpowers]

# or block style:
plugins:
  - commit-commands@anthropics/claude-plugins-official
  - superpowers@aberezin/superpowers
```

Each entry is **`<plugin-name>@<owner>/<repo>`** — the full form. `<owner>/<repo>`
is the GitHub slug the marketplace lives under; the entrypoint registers it
with `claude plugin marketplace add <owner>/<repo>`, derives the marketplace's
short name from the trailing `<repo>` segment, and installs the plugin as
`<plugin-name>@<repo>`. Bare short-form entries like `commit-commands@claude-plugins-official`
are rejected — they can't be registered unambiguously.

## Semantics (additive)

Three knobs that interact:

| Scenario | Default plugin (hardcoded) | `plugins:` list |
|---|---|---|
| No `plugins:` key | installed | — |
| `plugins: []` (empty) | installed | none added |
| `plugins: [a, b]` | installed | a and b both added |
| `DRIDOCK_DEFAULT_PLUGINS=0` | skipped | skipped (opts out of **everything**) |

The default plugin set (currently `commit-commands@claude-plugins-official`) is
always installed unless the env opt-out is set. Projects declare **additional**
plugins; removing an entry from the list does NOT run `claude plugin uninstall`.
Uninstall is a destructive action owned by the user, not the harness.

## Gating (matches the default installer's gate)

The per-project installer skips in the same contexts as the hardcoded default:

- `setup-token` runs
- Programmatic subsequent runs (where `.<container>_prog-args` is present)
- Any run with `-p` / `--print` in its argv (one-shot programmatic calls)

Only real human/interactive first-starts install plugins. This is deliberate:
plugin install is slow (`claude plugin marketplace add` clones from GitHub) and
offline, so a daemon start or an ephemeral test container shouldn't eat that
latency.

## Markers (per-plugin, matches features)

Each plugin's install sets a marker on first success: `~/.claude/.plugin-<slug>`,
where `<slug>` is the entry string with `/` replaced by `_`. **Marker set only
on success** — an offline failure leaves no marker, so the next start retries.
And the marker is per-plugin, so one failed install does NOT mark its siblings
done.

A user who later `claude plugin uninstall`s an entry isn't fought on next
start: the marker is still present, so the entrypoint doesn't try to reinstall.

## Why not pack this into `features:`?

Features and plugins are orthogonal:

- **Features** run `on.sh` scripts the harness ships (install an LSP server,
  write a git hook). Harness-authored, project-enabled. One install primitive:
  run a bash script.
- **Plugins** are Claude Code artifacts from external marketplaces (someone
  else's repo). The install primitive is `claude plugin marketplace add` +
  `claude plugin install`, which the harness doesn't own and can't bundle.

Conflating them would mean every plugin needs a stub `on.sh` + off.sh under
`/usr/local/lib/dridock/features/<name>/` for a job the Claude CLI already does.

## Host↔image contract

`.plugins` is a new sidecar file — written by the host wrapper (TS
`AuthSecretsProvisioner.writePluginsSidecar`, parsed by `ProjectConfig.plugins`),
read by the container entrypoint (`_install_project_plugins`). That's a host↔image
IPC change, so 5.9.0 bumps `VERSION` + `dridockVersion.ts` together per
[versioning.md](../versioning.md). An older image won't read `.plugins` and
will silently install only the hardcoded default — no crash, just no per-project
plugins. An older host won't write `.plugins` and the entrypoint's `[ -f "$pf" ] || return 0`
guards against the absent file.

## Reference

- `dridock-ts/src/services/ProjectConfig.ts` — `plugins(configPath)` and `parsePlugins()`
- `dridock-ts/src/services/AuthSecretsProvisioner.ts` — `writePluginsSidecar()`
- `entrypoint.sh` — `_install_project_plugins` (runs after `_maybe_install_default_plugin`)
- #96 — the implementation issue; #95 — the superpowers filing that motivated it

## See also

- [features-system.md](features-system.md) — the mechanism this one mirrors.
- [convenience-scripts.md](convenience-scripts.md) — a parallel axis: container-side `cb-*` commands aren't plugins either.
- [framework-guidance.md](framework-guidance.md) — how framework guidance (including the three-way distinction between features, plugins, and skills) reaches every claudebot.
- [versioning.md](../versioning.md) — the `VERSION` + `dridockVersion.ts` bump this ship needed.

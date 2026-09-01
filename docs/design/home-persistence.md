# `$HOME` persistence — design

How agent-written dotfiles survive a container recreate. Tracks
[#80](https://github.com/aberezin/docker-claudebox/issues/80); folds in
[#55](https://github.com/aberezin/docker-claudebox/issues/55).

## The failure class

Only the workspace and a handful of bind mounts survive a container recreate.
`$HOME` lives on the container filesystem, so **anything an agent writes under
`~/` is silently lost** — while its *session* survives (that lives in
`~/.claude`), so the claudebot's memory says "as we agreed, `pull.rebase=false`
is set" and is wrong every morning after a recreate.

Concretely lost today: every `git config --global` an agent ran, the `gh`
credential helper (#55), `~/.git-credentials`, `.bash_history`,
`~/.config/gh/hosts.yml`, and anything a future tool writes to `~/`.

Recreate is routine — a `make build` plus `dridock start` is enough, because
`ContainerRefresher` deletes any container whose image id no longer matches.

## Phase 1 — baked content out of `$HOME` (shipped, 5.0.1)

`$HOME` could not be bind-mounted while the image baked 321 MB of Claude CLI
plus the entrypoint and daemons into it: the mount would shadow all of it and
the container would not start.

| was | now |
|---|---|
| `/home/claude/.local/` (CLI) | `/opt/claude-cli/` (`PATH` via a stable `bin/claude` symlink) |
| `~/entrypoint.sh`, the five daemons, `CHANGELOG.md` | `/opt/dridock/` (`ENTRYPOINT` follows) |

`$HOME` is now `.bashrc`, `.profile`, `.bash_logout`, `.inputrc` — distro skel
plus our readline config — and the mount points.

**No host↔image contract change.** The host never invoked `entrypoint.sh` by
path; docker uses the image's own `ENTRYPOINT`, which moved with it.

## Phase 2 — the `dot/` mount (not yet built)

### Decision: the mount is PER PROJECT

Source is `<xdg>/dridock/projects/<id>/dot/`, mounted at `/home/claude/`.

Per-project matches how the data dir is already scoped, and keeps the blast
radius of a bad dotfile to one project. The cost is that two claudebots on
different projects do **not** share shell history or git config — each learns
its own. That is the intended trade: a project's environment is part of the
project, and cross-project leakage is the thing per-project VMs exist to prevent.

### Decision: `.claude` is FOLDED IN, not nested

`~/.claude` stops being its own bind mount and becomes an ordinary directory
*inside* the `dot/` mount. One mount, one lifetime, one thing to reason about —
rather than a mount nested inside a mount, which behaves differently under
`docker start` than `docker run` and is a standing source of ordering bugs.

**This requires migrating real user data**, and it is the riskiest part of
phase 2:

```
<xdg>/dridock/projects/<id>/claude/      →  <xdg>/dridock/projects/<id>/dot/.claude/
```

That directory is not incidental — a live project here holds **27 MB**:
sessions under `projects/`, `history.jsonl`, `plugins/`, `bin/`, `cron/`,
`file-history/`, the injected `CLAUDE.md`, and the OAuth credentials. Losing it
loses the agent's memory and its login.

The IPC sidecars (`.claude-<container>_prog-auth`, `-env`, `-secrets`, `-args`)
live inside that same directory, so their **host** path moves with it while
their **container** path (`~/.claude/…`) does not. Host and container must be
changed together or the sidecar handoff breaks silently — the class
`docs/design/agent-teams-delivery.md` and #30 both document.

### Decision: exclusions are mounts, not a config list

Bind mounts cannot exclude subpaths. Each exclusion has to be its own mount
(anonymous volume or tmpfs) over the excluded path — `~/.cache`, `~/.npm`,
`~/go/pkg/mod`, `~/.local/share/pnpm/store`.

The point survives the mechanism: with `$HOME` empty of baked content the
**default flips from silent-drop to persist**, so a forgotten exclusion wastes
disk *visibly* instead of losing state *silently*. That is the direction this
repo's rules push every time.

### Required: the mount must be version-gated

The dangerous upgrade direction is **new host + old image**, not the reverse. An
old image still bakes the CLI and entrypoint into `$HOME`; a new host that mounts
over it shadows them and produces containers that cannot start.

So the host must read `org.dridock.version` off the image (the label added in
[#78](https://github.com/aberezin/docker-claudebox/issues/78), already read by
`ImageEnsureService` and `checkversion`) and mount **only** when the image is at
or past the release that introduced phase 2. Old host + new image is the safe
direction: no mount, dotfiles stay ephemeral, i.e. today's behaviour.

### Still open

- The skel files (`.bashrc`, `.profile`, `.bash_logout`, `.inputrc`) need
  runtime seeding once a mount covers `$HOME`, or a fresh project gets a shell
  with no rc at all.
- First-run migration must copy an existing container's `$HOME` into the new
  dir before the mount takes effect, so an agent mid-flight does not lose
  accumulated state.
- Whether phase 2 lands in the same major as the 6.0.0 migrator removal already
  committed in [roadmap.md](../roadmap.md). Two large changes in one release is
  worth avoiding.

## See also

- [per-project-vm.md](per-project-vm.md) — the VM isolation model this sits inside.
- [../roadmap.md](../roadmap.md) — committed removals and the tests enforcing them.
- [agent-teams-delivery.md](agent-teams-delivery.md) — the sidecar IPC that moves with the data dir.

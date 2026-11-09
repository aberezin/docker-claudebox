# Project-level vs machine-local config

> **Shipped in 5.10.0 (#97).** Splits `.dridock/project.yml` (tracked) out of
> `.dridock/config.yml` (gitignored). The old location still works and is
> removed in **7.0.0** — see [roadmap.md](../roadmap.md).

A dridock project has two kinds of settings, and before 5.10.0 they shared one
file that could not satisfy both.

| | `.dridock/config.yml` | `.dridock/project.yml` |
|---|---|---|
| git | **gitignored** | **tracked — commit it** |
| created by | `bootstrap` / first `start` | lazily, on first use |
| `id` | ✅ the colima profile identity | |
| `vm.{cpu,memory,disk,autostop}` | ✅ sized for this host | |
| `network.hostname` | ✅ an `/etc/hosts` alias | |
| `features:` | legacy, still read | ✅ |
| `plugins:` | legacy, still read | ✅ |

## Why config.yml is gitignored

Every key it was born holding is machine-local:

- **`id`** generates the colima profile name `cb-<id>`. If it were committed,
  two clones — or, on this fork's own development machines, two macOS accounts —
  would claim the *same* VM and fight over it. "Each fresh clone gets its own
  VM" is the sane default ([per-project-vm.md](per-project-vm.md)).
- **`vm.cpu` / `vm.memory` / `vm.disk`** are sized against the host. 8GiB on a
  laptop is not 8GiB on a CI box.
- **`network.hostname`** writes an `/etc/hosts` alias pointing at the VM's
  current IP. Meaningless on another machine.

So `bootstrap` generates the file and appends it to the project `.gitignore`.
That decision was right and has not changed.

## The problem it created

`features:` and `plugins:` are not machine-local. "This project needs the
TypeScript tool bundle and the superpowers skills" is a property of the
**project**, identical in every clone — so it belongs in git, and it was sitting
in the one file engineered not to travel.

Consequences before the split:

- Every clone and every account re-entered the list by hand.
- There was no way to state a project's plugin set *at all* such that a
  collaborator got it.
- `dridock features enable X` wrote to a file git would never show you, so the
  change was invisible in review.

`profiles:` carried this defect since 3.x without anyone noticing. #96's
`plugins:` inherited it, and that is what surfaced it: the whole point of
per-project plugins is that the project declares them.

## Resolution is a union

Reads take `project.yml` ∪ `config.yml`, project entries first, deduped:

```
project.yml   features: [typescript]
config.yml    features: [python, go]
effective     typescript, python, go
```

Union rather than override, for two reasons:

1. **The installs are already additive and marker-guarded** —
   `~/.claude/.feature-<name>` and `~/.claude/.plugin-<slug>`. "The project
   needs these, and I also want these locally" composes naturally.
2. **An override would silently stop installing** a pre-5.10.0 project's
   features the moment anyone created a `project.yml`. That is the
   never-silently-discard class ([CLAUDE.md](../../CLAUDE.md)) and this repo has
   re-learned it enough times.

Entries found in the legacy location are **applied**, then named once on stderr:

```
ℹ features: in .dridock/config.yml (python) — still applied, but config.yml is
  gitignored so it can't travel with a clone. Move it to .dridock/project.yml
  (tracked). The config.yml location is removed in 7.0.0.
```

`features list` and `plugins list` also tag those entries `(config.yml — local
only)`, because a user reading the list needs to know which half is committed.

## Writes

`features enable` / `plugins add` write to **`project.yml`**, creating it on
first use. Bootstrap deliberately does *not* scaffold it: nothing should appear
in someone's git tree unasked, so an existing project sees no change until it
sets a project-level key.

The file is born with a header describing the split. Being tracked, that header
is the documentation a reader actually encounters — which is why there is no
`project.sample.yml` to fall out of date beside it (unlike
`config.sample.yml`, which documents the gitignored file precisely *because*
nobody can read the real one).

`features disable` / `plugins remove` delete the name from **both** files. Since
reads are a union, clearing only `project.yml` would leave a `config.yml` copy
still installing it while the command reported success.

A consequence worth stating plainly: **`dridock features enable typescript` now
dirties your git tree.** That is correct. It just changed a fact about the
project that belongs in a commit.

## What this does not do

- **No pinning.** A `plugins:` entry is `name@owner/repo`; the marketplace
  tracks its HEAD. A second `@` does not parse. Pinning a plugin version is a
  syntax change, not a config change.
- **No per-clone opt-out of a project-declared entry.** Union means a clone can
  add, not subtract. `DRIDOCK_DEFAULT_PLUGINS=0` opts out of everything, all or
  nothing. If a finer knob is ever needed, `plugins_exclude:` in `config.yml` is
  the shape to reach for — deliberately not built on spec.
- **No change to the container contract.** `config.yml` is host-only; the
  entrypoint reads the `~/.claude/.features` and `~/.claude/.plugins` sidecars,
  whose names and formats are untouched. An older image behaves identically.

## Rejected alternative

Un-ignore `config.yml` and move `id` to a gitignored `.dridock/id`. Fewer
files — but `vm.*` and `network.hostname` are still machine-local, so the split
relocates rather than disappears, while also changing `config.yml`'s second job
as the *is-this-a-dridock-project* sentinel and inverting bootstrap's
generate-then-ignore flow. More churn for the same end state.

## See also

- [per-project-vm.md](per-project-vm.md) — why `id` and `vm.*` must stay machine-local.
- [features-system.md](features-system.md) — the `features:` mechanism itself.
- [plugins-system.md](plugins-system.md) — the `plugins:` mechanism and its install path.
- [bootstrap.md](bootstrap.md) — what project setup writes, and what it deliberately does not.
- [../roadmap.md](../roadmap.md) — the 7.0.0 removal of the `config.yml` location.
- [../versioning.md](../versioning.md) — why this is a MINOR and not an IPC change.

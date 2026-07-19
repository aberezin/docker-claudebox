# Features system (design)

**Status:** Draft / accepted direction for 3.0. Broadens the existing `profiles:` system.
**Tracked in:** [Issue #5](https://github.com/aberezin/docker-claudebox/issues/5).
**Written:** 2026-07-19. **Target:** 3.0 breaking migration (`3.0-bundle`).

## Context

The current `profiles:` system in `.claudebox/config.yml` opts a project into
language-specific tool bundles. Three profiles exist as of 2.x: `go`, `python`,
`typescript`. Each activates a Claude Code LSP plugin whose language-server binary is
already baked into the image. The profile script (`profiles/<name>.sh`) is essentially
empty except for turning the plugin on. See [profiles.md](profiles.md) for the current
design.

**Problems this system doesn't solve today:**

1. **No off-language framework opt-ins.** SSH-key generation in `install.sh`,
   `browser-bridge`, `host-agent`, CDP requirements, framework-dev-mode override — each
   is opt-in via a *different* mechanism (env var, subcommand, marker file, fingerprint
   detection). No single place a project declares "I use X."
2. **No teardown.** `profiles/<name>.sh` runs once at first enable. There's no
   `off.sh` — a project can never fully "disable" a profile it once enabled.
3. **Baked binaries are implicit.** The three current profiles all assume their server
   binary was baked at image build. A general plugin system needs an explicit answer
   to "how does a plugin get its binary dependencies?" for cases beyond
   maintainer-blessed baking.
4. **No machine-wide defaults.** `~/.config/claudebox/config.yml` doesn't currently
   propagate feature preferences to every new project.
5. **Adding a plugin today requires editing the Dockerfile.** For any user-authored
   plugin (a company-internal auth setup, a local dev-server), the current system
   offers no route — the user would have to fork the harness and rebuild.

## Decision

Broaden `profiles:` into a **`features:`** system with:

1. **Renamed config key** — `.claudebox/config.yml` `features: [...]` replaces
   `profiles: [...]`. `profiles:` accepted as a backward-compat alias for one
   deprecation cycle (3.x); removed in 4.0. Existing LSP profiles migrate as-is.
2. **Manifest per feature** — each `features/<name>/` (baked into image) contains:
   - `manifest.yml` — metadata: `name`, `description`, `requires-bake: bool`, optional
     dependencies on other features.
   - `on.sh` — runs once at first enable (marker-guarded, same pattern as today's
     `profiles/<name>.sh`).
   - `off.sh` — runs once at disable (removes the marker; reverses `on.sh`'s effects
     where possible).
   - `bake.sh` (optional) — image-build-time step, only invoked for features with
     `requires-bake: true` when the Dockerfile is built.
3. **Two-tier binary strategy** —
   - **Runtime-install (default)**: `on.sh` handles small deps (`apt-get`, `pip`,
     `npm`, `curl` a single binary). Cost: first-enable is slower and requires network
     at that moment. Fine for lightweight tools.
   - **Baked (`requires-bake: true`)**: heavy deps (~tens of MB, whole toolchains,
     language servers) declare this in the manifest. The Dockerfile iterates over a
     **maintainer-blessed list** of `requires-bake` features and runs each's `bake.sh`
     at image build. User-authored project-local features (see below) can't set
     `requires-bake: true` — they'd have no way to influence image build; they must
     runtime-install.
4. **Machine-wide defaults** — new `~/.config/claudebox/config.yml`
   `default_features: [...]` field that seeds every new project's `features:` list.
   Wrapper reads both files and merges (project-level entries take precedence).
5. **Project-local features** — new lookup path `.claudebox/features/<name>/` (in the
   project workspace, gitignored by default). Users can drop in `on.sh` / `off.sh` /
   `manifest.yml` for one-off project needs without forking the harness. These can't
   `requires-bake: true` (see above) but everything else works identically.
6. **Migration path for existing 2.x profiles** — the three LSP profiles become
   features with `requires-bake: true` (their servers were baked), zero user-visible
   change. Their scripts move from `profiles/<name>.sh` to `features/<name>/on.sh`.
   Adding a companion `off.sh` for each (disable the plugin) is small.
7. **CLI surface** —
   - `claudebox features` (`profiles` alias for one cycle) — list enabled + available.
   - `claudebox features enable <name>` / `disable <name>` — edit `.claudebox/config.yml`
     safely; run `on.sh` / `off.sh` immediately if the container is up.
   - `claudebox features info <name>` — show the manifest.

## Consequences

**Positive:**
- SSH-git keygen, browser-bridge, host-agent, and framework-dev-mode override become
  uniformly opt-in from one config surface. `install.sh` no longer unconditionally
  generates an SSH key.
- User-authored features unblock private / project-internal customization without
  fork+rebuild.
- Machine-wide defaults reduce per-project config toil ("I always want ssh-git;
  don't ask me again").
- `off.sh` gives genuine feature toggles instead of "enabled forever" semantics.

**Negative / to plan for:**
- **`.claudebox/features/` in the workspace** is a new place users can drop code that
  runs in the container. Trust posture: the `on.sh` runs as the `claude` user with
  passwordless sudo, so a malicious project-local feature has container-full-control.
  This is no worse than the existing `.claudebox/init.d/` pattern and doesn't cross
  the VM boundary — but it should be documented as a trust surface, and framework-dev
  mode should probably require an extra opt-in for auto-running project-local features
  (paranoia budget).
- **Runtime-install first-enable cost** — depends on what's installed. Small pip
  packages, single-binary curls: seconds. `apt-get install` of larger toolchains:
  minutes. Cache-friendly (marker-guarded so it's once per project), but visible.
- **`requires-bake` gate is a manual maintainer step.** Adding a baked feature means
  the maintainer reviews the `bake.sh` and adds the feature name to the Dockerfile's
  bake-list. That's a real editorial responsibility; not a design flaw, but must be
  named.
- **Migration path for existing 2.x users** — reading `profiles:` as an alias covers
  most cases, but the disk layout changes (`profiles/foo.sh` → `features/foo/on.sh`).
  Existing project VM markers (`~/.claude/.profile-<name>`) need to be recognized so a
  project that had `profiles: [typescript]` in 2.x doesn't re-run the installer on
  3.0's first boot. Add compat: check both `.profile-<name>` and `.feature-<name>`
  markers.

## Alternatives considered

- **All-runtime install (no `requires-bake` option)** — image stays lean; every feature
  installs at first-enable. Simplifies the maintainer workflow (no bake-list to
  curate) at the cost of every project paying a slow first-enable for common features
  like the LSP servers. Rejected: the 3 current profiles' servers weigh tens of MB
  each; re-downloading them per project is worse UX than one bigger image.
- **Layered images (one Docker layer per feature)** — `features: [rust]` triggers a
  build of `claudebox:latest+rust`. Cache-friendly but forces per-project image
  variants; `cb-infra` now has to hold N images. Rejected: matrix explosion (2^N
  images for N features), complex `checkversion` semantics, migration nightmare.
- **Keep `profiles:` name, broaden its meaning** — "profile" retains its LSP-tool
  connotation in the docs and in user mental model; broadening to include SSH-git
  strains the term. Rejected on naming clarity. But the config-file alias
  (`profiles:` → `features:`) covers backward compat without keeping the term
  everywhere.
- **Fold framework-dev-mode into `features:`** — argued against in
  [framework-dev-mode.md](framework-dev-mode.md): mode ≠ feature. The auto-detected
  fingerprint check doesn't fit an opt-in feature flag surface. Rejected. But
  `CLAUDEBOX_HARNESS_DEV=1` (the manual override) could become
  `features: [harness-dev]` — that's a legitimate opt-in shape. TBD in
  implementation.

## Open questions

- **`manifest.yml` schema** — what fields exactly? Suggested minimum: `name`,
  `description`, `requires-bake` (bool, default false), `depends-on` (list of other
  feature names, optional).
- **Feature dependency resolution** — if feature A depends on feature B, does enabling
  A auto-enable B? Or error out and require the user to enable both? Simpler: error,
  point at the missing dep.
- **Marker file location** — today's profile marker is `~/.claude/.profile-<name>`.
  Rename to `.feature-<name>`? Then keep both readable for one cycle for 2.x → 3.0
  migration.
- **Interaction with the `dridock` rebrand (Issue #11)** — do baked features live in
  `dridock/features/` or stay `claudebox/features/` for the deprecation cycle? Cross-
  reference decision when #11 is worked.
- **How do we test features?** — the bash suite has no notion of features today.
  Adding a `test_features.sh` that enables + disables each baked feature against a
  throwaway VM is straightforward but real test-suite work.

## See also

- [Issue #5](https://github.com/aberezin/docker-claudebox/issues/5) — where this
  design tracks.
- [profiles.md](profiles.md) — the current 2.x profile system this supersedes.
- [Issue #11](https://github.com/aberezin/docker-claudebox/issues/11) — the dridock
  rebrand; interacts with feature-name / directory naming decisions.
- [Issue #10](https://github.com/aberezin/docker-claudebox/issues/10) — SSH-for-git;
  the first non-LSP feature this system enables (`ssh-git` becomes a feature).
- [framework-dev-mode.md](framework-dev-mode.md) — the argument for why runtime modes
  don't fit into the features surface.
- [bootstrap.md](bootstrap.md) — where `.claudebox/config.yml` semantics are documented.

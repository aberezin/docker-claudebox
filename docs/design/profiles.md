# Profiles — opt-in tool bundles per project

> **Superseded (2026-07-20):** the `profiles:` system was broadened into the general
> **features** system in 3.0 (issue #5). Config key: `profiles:` → `features:` (both
> accepted for one deprecation cycle, removed in 4.0). File layout: `profiles/<name>.sh`
> → `features/<name>/{manifest.yml, on.sh, off.sh}`. CLI: `dridock features` supersedes
> `dridock profiles`. See [features-system.md](features-system.md) for the shipped
> design. Content below describes the pre-3.0 system — kept for historical reference
> and because 2.x images still ship it (the 3.0 wrapper reads either layout).

> **Rebrand note (3.0):** the project dir moves from `.claudebox/` to `.dridock/`; the
> profile installer path moves from `/usr/local/lib/claudebox/profiles/` to
> `/usr/local/lib/dridock/profiles/`. 2.x paths continue to work during the deprecation
> cycle.

As dridock grows, a claudebot needs project-appropriate tooling — a TypeScript
language server here, Python there — without baking *every* tool into *every* image or
making each consumer hand-write `init.d` scripts. **Profiles** are the middle layer: a
project names the bundles it wants, and the harness turns them on.

## The model

- A **profile** is a named, curated installer the fork ships in the image at
  `/usr/local/lib/dridock/profiles/<name>.sh`, with a `# summary:` header.
- A project **opts in** via `.dridock/config.yml`:

  ```yaml
  profiles: [typescript, python]      # flow style
  # or block style:
  # profiles:
  #   - typescript
  #   - go
  ```

- On first enable, the entrypoint runs the matching installer **once** (marker in
  `~/.claude/.profile-<name>`, set only on success so an offline failure retries next
  start), as the `claude` user. Adding a profile later takes effect on the next
  `dridock` run — no container recreation needed.
- `init.d/*.sh` remains the **escape hatch** for anything a profile doesn't cover.

## Baked binaries vs. installed-by-profile

A profile is "**make language X work**," and it hides *how*:

- **Small, common language servers are baked into the image** (`gopls`,
  `typescript-language-server`, `pyright`), so their profile just **enables the Claude
  Code plugin** — no per-project install, offline-safe, deterministic.
- **Heavy or niche servers** (e.g. `rust-analyzer`, `clangd`) are **installed by their
  profile**, so only projects that opt in pay the size/latency.

The consumer writes `profiles: [typescript, rust]` and it works either way — the
baked-vs-installed choice is a per-tool maintainer decision, not something the user
sees. (Policy: bake small+common, profile heavy+niche. On this fork, not-offline +
image-size-not-a-concern, so the common LSPs are baked.)

## Why not the alternatives

- **Bake everything** → the ~8 GB `full` image balloons, and every project pays for
  languages it doesn't use.
- **Auto-detect only** (`tsconfig.json` → TS) → implicit and hard to opt out of, and
  can't cover tools you can't infer from files. (Auto-detect is fine as a *convenience
  default* layered on top — enable a profile unless `profiles:` is set explicitly — but
  the explicit list is the source of truth.)
- **Everyone writes their own `init.d`** → no standardization; the common 80%
  (language servers) gets reinvented per project. Profiles standardize that; `init.d`
  stays for the bespoke 20%.

The `full` vs `minimal` image variants are the coarse version of this lever: `full`
bakes the common servers; `minimal` bakes none and leans entirely on profiles.

## Using them

```bash
dridock profiles          # list this project's enabled profiles + the ones available in the image
# then edit .dridock/config.yml → profiles: [typescript], and run:
dridock                    # the entrypoint installs each enabled profile once
```

## Adding a profile (maintainer)

1. Add `profiles/<name>.sh` — an executable with a `# summary:` header that installs
   whatever the bundle needs (enable a plugin, and/or install a server binary).
2. It's `COPY`d to `/usr/local/lib/dridock/profiles` and `chmod +x`'d by the
   `Dockerfile` (already wired for the `profiles/` dir).
3. If it needs a heavy binary, install it in the profile script; if the binary is
   cheap+common, consider baking it in the image instead (see the policy above).
4. Bump the version (new baked capability → MINOR) and document it here.

## See also

- [convenience-scripts.md](convenience-scripts.md) — the `cb-*` command convention (the
  same "shipped, self-describing, `init.d` as escape hatch" philosophy).
- [per-project-vm.md](per-project-vm.md) — `.dridock/config.yml` and per-project `~/.claude`.
- [customization.md](../customization.md) — `init.d` hooks and plugins (the escape hatch).
- The top-level `CLAUDE.md` — conventions for adding profiles.

# Convention: `cb-*` convenience commands (inside the container)

As dridock grows, the claudebot needs small, discoverable helper commands for the
things the harness standardizes — browser testing, framework bug reports, and more to
come. Rather than scatter ad-hoc scripts, they follow one convention so the set stays
self-describing.

## The convention

1. **Name it `cb-<name>`.** Every dridock convenience command is an executable whose
   basename starts with `cb-` (e.g. `cb-browser`, `cb-report-bug`, `cb-help`). The
   shared prefix makes them one discoverable namespace (`cb-<TAB>`), and marks them as
   "provided by the harness" vs. the project's own tooling. (The `cb-` prefix is
   preserved from the 2.x `claudebox` name; the container-side convention is stable
   across the 3.0 rebrand.)

2. **Carry a one-line `# summary:` header.** Near the top of the script:

   ```bash
   #!/usr/bin/env bash
   # summary: <what it does, in one line>
   ```

   `cb-help` extracts this line to describe each command. No summary → it lists the
   command with `—`.

3. **Location by lifetime:**
   - **Shipped/baked** commands live in **`/usr/local/bin`** — `COPY`d into the image
     and `chmod +x`'d in the `Dockerfile`, so every claudebot has them.
   - **Per-project or ad-hoc** commands go in **`~/.claude/bin`** — that dir is on
     `PATH` and lives in the mounted per-project `~/.claude`, so it survives container
     rebuilds and can differ per project. Good for project-specific helpers a claudebot
     or a human drops in.

4. **Discovery: `cb-help`.** Scans every `PATH` dir for `cb-*` executables and lists
   them with their summaries. Because it's discovery-based, adding a new `cb-*` command
   (baked or in `~/.claude/bin`) makes it show up automatically — no registry to edit.

5. **Self-documenting.** Each command should also respond to `--help` (or have a clear
   header comment) for details beyond the one-line summary.

## Why not the host `dridock` CLI?

The host `dridock` wrapper is **not** inside the container (it's the host-side
orchestrator that manages VMs/containers). Inside the container the claudebot has
`claude`, the docker socket, and these `cb-*` commands. So container-side convenience
belongs in `cb-*`, and host-side convenience belongs in `dridock <subcommand>`.

## Unified surface (`dridock <verb>` alias, #1)

3.0 bakes a **`/usr/local/bin/dridock`** shim in the container that unifies the
command surface across the host↔container boundary. From either side, the user types
`dridock <verb>` and gets the right behavior:

- **Container-side verbs** (`consult`, `report-bug`, `browser`, `df`, `help`) route to
  their `cb-*` implementation — `dridock consult read <id>` runs the same code as
  `cb-consult read <id>`. Both names work; `cb-*` remains canonical (referenced in
  header comments, help text, and docs). The alias is for reflex-consistency: the
  same verb the user types on the Mac works here.
- **Host-only verbs** (`start`, `stop`, `vm`, `ip`, `net`, `bootstrap`, `migrate`,
  `checkversion`, …) print a targeted "run this on your Mac" message with the exact
  incantation (`cd <DRIDOCK_WORKSPACE> && dridock <verb>`) rather than a generic
  "unknown command" — so the claudebot immediately knows WHY it didn't work and
  WHERE to run it. Exit status 2.
- **Unknown verbs** exit 1 with a hint to run `dridock help`.

The container also carries a **`/usr/local/bin/claudebox`** symlink pointing at
`dridock`, so 2.x muscle memory still works for one deprecation cycle.

`cb-help` lists the `cb-*` set (unchanged); `dridock help` inside the container adds
the host-side verbs with a "run on Mac" marker, giving a single reference for the
full surface. Full split rationale: issue [#1](https://github.com/aberezin/docker-claudebox/issues/1).

## Surfacing it to the claudebot

- The baked `CLAUDE.md` tells the claudebot that `cb-*` commands exist and to run
  `cb-help` to list them.
- The container-side `/dridock` skill (seeded by the entrypoint) runs `cb-help` as
  part of its self-report.

## Env-var reads inside a `cb-*` helper (3.x compat window)

The 3.0 rebrand renamed the env-var prefix `CLAUDEBOX_*` → `DRIDOCK_*`. During
3.x, the entrypoint's `_dridock_alias_env` shim symmetrically mirrors every pair
in `env-rename.map` after sidecar load, so **an existing `cb-*` helper reading
either `${DRIDOCK_VM_IP:-}` or the legacy `${CLAUDEBOX_VM_IP:-}` still works**
(the shim exports both from the same value).
DO NOT roll a per-helper compat check for legacy env names — the shim covers it,
and per-helper checks were the exact pattern that let the `cb-browser` bug in
#16 slip past every review.

When you're editing an existing helper anyway, do the small courtesy of migrating
its reads to `${DRIDOCK_X:-${CLAUDEBOX_X:-}}` — that way, when 4.0 removes the
shim, the helper still works with the canonical name. New helpers written from
scratch should read only `${DRIDOCK_X:-}`. Full standard:
[env-var-rename.md](env-var-rename.md).

## See also

- [browser-testing.md](browser-testing.md) — `cb-browser`.
- [framework-bug-reporting.md](framework-bug-reporting.md) — `cb-report-bug`.
- [framework-consult.md](framework-consult.md) — `cb-consult` (the container side of a consult).
- [env-var-rename.md](env-var-rename.md) — 3.x `CLAUDEBOX_*` ↔ `DRIDOCK_*` compat standard.
- The top-level `CLAUDE.md` "Conventions worth knowing".

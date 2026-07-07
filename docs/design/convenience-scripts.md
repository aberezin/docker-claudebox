# Convention: `cb-*` convenience commands (inside the container)

As claudebox grows, the claudebot needs small, discoverable helper commands for the
things the harness standardizes — browser testing, framework bug reports, and more to
come. Rather than scatter ad-hoc scripts, they follow one convention so the set stays
self-describing.

## The convention

1. **Name it `cb-<name>`.** Every claudebox convenience command is an executable whose
   basename starts with `cb-` (e.g. `cb-browser`, `cb-report-bug`, `cb-help`). The
   shared prefix makes them one discoverable namespace (`cb-<TAB>`), and marks them as
   "provided by the harness" vs. the project's own tooling.

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

## Why not the host `claudebox` CLI?

The host `claudebox` wrapper is **not** inside the container (it's the host-side
orchestrator that manages VMs/containers). Inside the container the claudebot has
`claude`, the docker socket, and these `cb-*` commands. So container-side convenience
belongs in `cb-*`, and host-side convenience belongs in `claudebox <subcommand>`.

## Surfacing it to the claudebot

- The baked `CLAUDE.md` tells the claudebot that `cb-*` commands exist and to run
  `cb-help` to list them.
- The container-side `/claudebox` skill (seeded by the entrypoint) runs `cb-help` as
  part of its self-report.

## See also

- [browser-testing.md](browser-testing.md) — `cb-browser`.
- [framework-bug-reporting.md](framework-bug-reporting.md) — `cb-report-bug`.
- The top-level `CLAUDE.md` "Conventions worth knowing".

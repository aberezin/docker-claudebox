---
name: dridock
description: Show a human-friendly summary of the dridock project in the current directory — versions (wrapper / cb-infra / project image), the paths that matter (config.yml, secrets.env, per-project data dir), VM + container status, and network (VM IP, hostname, cb-net). Use when the user runs /dridock or asks about their dridock setup, paths, data dir, VM, IP, or harness version.
---

# dridock — project status

When invoked, run the harness's own read-only info command in the current working
directory and relay it. It's fast and safe (reads state; never boots a VM or polls).

## Do this

1. Run:

   ```bash
   dridock info
   ```

2. Show the output to the user. It's already formatted as a human dashboard
   (versions, project paths, VM/container, network, machine paths) — present it
   as-is or lightly summarize; don't re-derive the values yourself.

3. Handle the common cases:
   - **"not a dridock project yet"** → this directory has no `.dridock/config.yml` (or its legacy 2.x sibling `.claudebox/config.yml`). Tell the user to `cd` into a dridock project, or run `dridock` here to initialize one.
   - **`dridock: command not found`** → the wrapper isn't installed/on PATH; point
     them at `./install.sh` in the harness repo. (A pre-3.0 install shipped the
     binary as `claudebox`; `dridock info` / `claudebox info` both work — the second
     name is the legacy symlink.)

## Follow-ups (only if the user asks)

- Version drift / "is a rebuild warranted?" → `dridock checkversion`
  (classifies MAJOR=must / MINOR=should / PATCH=optional).
- Disk usage across VMs → `dridock vm usage`; reclaim → `dridock vm gc`.
- The reachable IP + `/etc/hosts` line for a friendly hostname → `dridock net`.
- Upgrading a 2.x project to 3.0 → `dridock migrate` (or `--all` to sweep every
  legacy project data dir under `~/.config/claudebox/projects/` into `~/.config/dridock/`).

Keep it a quick glance — this is a human status check, not a deep dive.

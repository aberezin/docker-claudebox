---
name: claudebox
description: Show a human-friendly summary of the claudebox project in the current directory — versions (wrapper / cb-infra / project image), the paths that matter (config.yml, secrets.env, per-project data dir), VM + container status, and network (VM IP, hostname, cb-net). Use when the user runs /claudebox or asks about their claudebox setup, paths, data dir, VM, IP, or harness version.
---

# claudebox — project status

When invoked, run the harness's own read-only info command in the current working
directory and relay it. It's fast and safe (reads state; never boots a VM or polls).

## Do this

1. Run:

   ```bash
   claudebox info
   ```

2. Show the output to the user. It's already formatted as a human dashboard
   (versions, project paths, VM/container, network, machine paths) — present it
   as-is or lightly summarize; don't re-derive the values yourself.

3. Handle the common cases:
   - **"not a claudebox project yet"** → this directory has no `.claudebox/config.yml`.
     Tell the user to `cd` into a claudebox project, or run `claudebox` here to
     initialize one.
   - **`claudebox: command not found`** → the wrapper isn't installed/on PATH; point
     them at `./install.sh` in the harness repo.

## Follow-ups (only if the user asks)

- Version drift / "is a rebuild warranted?" → `claudebox checkversion`
  (classifies MAJOR=must / MINOR=should / PATCH=optional).
- Disk usage across VMs → `claudebox vm usage`; reclaim → `claudebox vm gc`.
- The reachable IP + `/etc/hosts` line for a friendly hostname → `claudebox net`.

Keep it a quick glance — this is a human status check, not a deep dive.

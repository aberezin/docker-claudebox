# Example: claudebot builds a todo app end-to-end

This is the canonical end-to-end demo. One command bootstraps a project and hands
claudebot a mission brief; claudebot then **autonomously** builds a small Node +
TypeScript todo web app and runs it as a **published container on its own Colima
VM**, reachable from your Mac's browser — no prompts, no hand-holding.

It exercises every layer:

| Layer | What it shows |
|-------|---------------|
| `claudebox bootstrap` | intent handoff — the committed `.claudebox/BRIEF.md` tells claudebot *why* it exists |
| per-project VM | a dedicated `cb-<id>` Colima VM with a host-reachable IP (`--network-address`) |
| per-project plugin | a TypeScript LSP plugin installed for this project via an init.d hook, giving claudebot TS code intelligence |
| autonomous build | claudebot writes the app (TS + Express, in-memory store) with `--dangerously-skip-permissions` (yolo) |
| docker-out-of-docker | claudebot builds an image and runs the app as a **sibling** container on the VM daemon |
| networking | the published workload is reachable from the Mac at the VM IP (and `localhost` as fallback) |

## Prerequisites

- `claudebox` on your PATH — run the repo's `./install.sh`, or
  `install -m755 wrapper.sh ~/.local/bin/claudebox` (ensure `~/.local/bin` is on PATH).
- The image built locally: `make build-minimal` (this example uses the minimal image).
- Auth exported: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
- Colima + `socket_vmnet` set up for reachable VM IPs (see the repo README's
  networking section).

## Run it

```bash
./run.sh                 # builds in /tmp/todo-app
./run.sh ~/demos/todos   # or pick your own dir
```

The first run spins up a fresh VM and seeds the image into it (a minute or two);
subsequent runs against the same project reuse the warm VM.

## What you should see

- `claudebox bootstrap` scaffolds the project (preflight ✓, git init, committed
  `BRIEF.md`).
- claudebot works autonomously and ends with a line like:
  `DONE: Container todo-app running detached on port 3000 …`
- The script prints the URLs. Open **`http://<vm-ip>:3000`** in Chrome — add,
  complete, and delete todos. Data is in-memory and resets if the container restarts.

## Talk to claudebot / inspect

```bash
cd /tmp/todo-app && CLAUDEBOX_MINIMAL=1 claudebox     # interactive session in the same project/VM
```
It can see everything it built (`src/server.ts`, `Dockerfile`, …) and the running
`todo-app` container. The `.claudebox/BRIEF.md` *Progress / handoff log* records what
it did.

## Plugins

`run.sh` drops an init.d hook (`init.d/10-typescript-lsp.sh`) into this project's
`~/.claude` before the build, so on first container-create claudebot installs the
official **`typescript-lsp`** plugin — a TypeScript/JavaScript language server that
gives it real code intelligence (go-to-definition, diagnostics, refactors) while it
writes the app. It's **per-project**: it lands in this project's own `.claude`, not
globally. Check it inside an interactive session with `claude plugin list`. (Separately,
the first *interactive* session also gets the baked default `commit-commands` plugin —
see `docs/customization.md`.)

## Tear down

```bash
cd /tmp/todo-app && claudebox destroy    # removes the project VM (and the workload with it)
rm -rf /tmp/todo-app
```

## Not a CI test

This demo is intentionally **not** in the automated suite: it drives a live model to
build an app, so it's slow, costs tokens, and produces a different (but working)
implementation each run. The *deterministic* mechanics it relies on — workspace
mounting under symlinked paths, and a published workload being reachable from the
host — are guarded by `tests/test_e2e.sh`.

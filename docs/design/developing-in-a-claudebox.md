# Runbook — developing the harness *inside* a claudebox

The operational recipe for editing, building, and testing **this harness** from a claudebot
running in a container (dogfooding), instead of directly on the Mac. It's the procedural
companion to [backends.md](backends.md) (which explains *why* the mechanism is shaped this way).

**It works** — proven end-to-end: a container with the repo mounted + the docker socket
auto-selected the docker backend, ran a real `make build-minimal` on its own daemon (no
Colima), and passed the unit suite in-container.

## What works where (set expectations first)

| | In-container (docker backend) | Needs `host-agent` | Mac-only |
|---|---|---|---|
| Edit `wrapper.sh`/`entrypoint.sh`/`Dockerfile`/docs | ✅ (files are live-mounted) | | |
| `make build` / `make build-minimal` | ✅ (builds on the claudebot's own VM daemon) | | |
| Unit tests (`tests/test_cbvm.sh`, `tests/test_bootstrap.sh`) | ✅ (pure bash — no Colima, no API) | | |
| Integration suite (`test.sh`) | ✅ on the docker backend (builds a minimal image + runs containers) | | |
| Real **Colima orchestration** — `vm gc`/`vm usage`, VM lifecycle, reachable-IP networking | | ⚠️ `claudebox host-agent up` (proxies `colima`/`limactl` to the Mac) | |
| A full **production** run (per-project VMs, reachable IPs, DooD across VMs) | | | ❌ macOS/Colima |

The rule of thumb: **the container layer + wrapper *logic* are testable in-container; the
Colima *orchestration* is Mac-native** (proxy it with the host-agent for the few tests that
need it).

## Setup

The harness repo is itself a claudebox project (`.claudebox/config.yml` lives in it). From a
checkout on the Mac:

```bash
cd <path-to>/docker-claudebox
claudebox            # boots a claudebot in this project's own VM, repo mounted at the same path
```

`CLAUDEBOX_BACKEND` **auto-selects `docker` inside the container** (it detects `/.dockerenv`),
so you usually don't set it — `make` and `test.sh` just do the right thing.

## The dev loop

Inside the claudebot (or any container with the repo + docker socket):

```bash
# 1. edit — wrapper.sh / entrypoint.sh / Dockerfile / docs are live-mounted, so edits are instant

# 2. build the image on THIS VM's daemon (docker backend, auto-detected; --minimal is faster)
make build-minimal          # or: make build   (full image, ~8 GB — see Disk below)

# 3. unit tests — fast, no image build, no API
bash tests/test_cbvm.sh
bash tests/test_bootstrap.sh

# 4. integration tests on the docker backend (builds a minimal image + runs containers)
CLAUDEBOX_BACKEND=docker bash test.sh          # needs tests/.env (see Auth); hits the live API on haiku
CLAUDEBOX_BACKEND=docker bash test.sh test_wrapper   # a single test, to iterate cheaply
```

## The trap: testing an `entrypoint.sh` / image change

The claudebot runs a **baked** entrypoint from its image. Editing `entrypoint.sh` in the repo
does **not** change the already-running container. To verify an entrypoint/image change you must
**build the image and run a fresh throwaway container from it** — the dogfood pattern:

```bash
REPO="$PWD"
make build-minimal                                  # bake your change into claudebox:latest-minimal
docker run --rm -v "$REPO:$REPO" -v /var/run/docker.sock:/var/run/docker.sock -w "$REPO" \
  --entrypoint bash claudebox:latest-minimal -lc '<exercise your change>'
```

(For wrapper/pure-function changes there's no such trap — `tests/test_cbvm.sh` sources
`wrapper.sh` directly, so it reflects your edits immediately.)

## Exercising real Colima (`host-agent`)

For changes to the Colima orchestration itself (`claudebox vm gc`, VM lifecycle, reachable-IP
networking), the docker backend can't help — those need a real VM. Turn on the **opt-in,
trusted** host agent on the Mac:

```bash
# on the Mac (trusted, single-operator — see backends.md security model):
claudebox host-agent up
#   restart the harness-dev claudebot so it picks up the injected agent URL/token
#   now inside it, `colima …`/`limactl …` execute on the Mac (allowlisted subcommands)
claudebox host-agent down
```

## Gotchas

- **Auth / credit.** The claudebot needs working Claude auth to operate at all. The API-key path
  can fail with "credit balance too low" / 403 — prefer the **subscription** (browser OAuth /
  `claudebox setup-token`, and `CLAUDEBOX_NO_API_KEY=1` to force it).
- **Integration suite needs `tests/.env`** with `CLAUDE_CODE_OAUTH_TOKEN` (it hits the live API on
  the cheap `haiku` model). Copy `tests/.env.example`. The **unit** tests need none of this.
- **Disk.** A full `make build` (~8 GB) + build cache lands on the claudebot's *own* VM overlay,
  which also hosts its `/tmp` — so it can ENOSPC-kill the Bash tool. Prefer `build-minimal`,
  `docker builder prune -f` between builds, and see [disk-management.md](disk-management.md)
  (`cb-df`, `CLAUDEBOX_PRUNE_ON_START`, `CLAUDEBOX_TMPFS_TMP`).
- **Version skew.** You're editing code while running an *image built from older code*. `make build`
  reconciles the image; the wrapper you run is the one on the host PATH (reinstall with
  `install.sh` to pick up wrapper edits on the host).
- **Nested DooD.** Test containers you launch are siblings on the claudebot's VM (via the mounted
  socket) — isolated to that VM, and cleaned up with it.

## See also

- [backends.md](backends.md) — *why* the backend abstraction + host-agent are shaped this way, and the security model.
- [per-project-vm.md](per-project-vm.md) — the VM/isolation model.
- [disk-management.md](disk-management.md) — keeping the dev VM's disk from filling during repeated builds.
- [../../CLAUDE.md](../../CLAUDE.md) · [../../README.md](../../README.md) — build/test commands and repo conventions.

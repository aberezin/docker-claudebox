# Backends — developing/testing the framework off the Mac (task #15)

**Status:** Approach 2 **phases 1 + 3 shipped**. Phase 1 (v2.14.0): the host agent + `colima`/
`limactl` shims, proven end-to-end (a bridge-network container drives real `colima list` on the
Mac). Phase 3 (v2.15.0): the "docker" decision — resolved as **docker LOCAL, not proxied** —
`make build` + the integration tests are backend-aware and run on the dev claudebot's own
daemon, so the harness builds+tests inside a container with no host-exec surface. This doc
captures both approaches, their trade-offs, and the security model.

> In 2.x this framework was called `claudebox`; 3.0 renames the host wrapper and harness to `dridock`. The `DRIDOCK_BACKEND` env var below is the canonical 3.0 name; `CLAUDEBOX_BACKEND` is still accepted as a legacy alias.

## The goal

Develop, build, and test **this harness** somewhere other than directly on Alan's Mac —
specifically **inside a dridock** (dogfooding — a claudebot editing `wrapper.sh`/
`entrypoint.sh` and running the suite) and/or in **Linux CI** (the repo currently has none).

## Why it's hard — the Colima coupling

The framework is deeply coupled to a **macOS host running Colima** (a Lima-based VM manager
that only exists on macOS):

- `wrapper.sh` has **~56 `colima`/`limactl` call sites** — VM lifecycle (`colima start/stop/
  delete`), per-project docker contexts (`colima-cb-<id>`), reachable IPs (`--network-address`,
  `col0`), image reseed between the `cb-infra` store VM and project VMs, lima disk GC.
- `make build` does `colima start cb-infra` + `docker --context colima-cb-infra build`.
- `tests/common.sh` spins a throwaway `colima` profile and builds/runs in its context.

You cannot run the Colima path inside a Linux container — there is no Colima there.

## The insight

Underneath, the real work is **plain Docker** (`docker build` / `docker run`). Colima only
provides the *substrate*: per-project VM isolation, the image store, reachable IPs, disk
management. And **inside a dridock you already have a Docker daemon** (the mounted socket /
DooD). So the question is only *how the framework reaches an orchestration substrate when it
isn't on the Mac* — and there are two very different answers.

## Approach 1 — a `docker` backend (`DRIDOCK_BACKEND`)

Introduce `DRIDOCK_BACKEND = colima | docker` and factor the backend-specific ops behind
dispatch helpers:

| Op | `colima` (default, macOS/prod) | `docker` (CI / in-container) |
|---|---|---|
| context | `colima-cb-<id>` | default / ambient daemon |
| ensure-up | `colima start <profile>` | no-op (daemon already there) |
| image | build into `cb-infra`, reseed to project VMs | just `dridock:latest` locally, no reseed |
| address | reachable `col0` IP (rotating) | `localhost` (published ports) |
| gc / usage | lima disks + `fstrim` | `docker system prune` / `df` |

The **container layer (entrypoint + image) is unchanged** — it runs in a container either way.

- **Delivers:** the suite (and `make build`) runs on plain Docker → Linux CI and in-container dev.
- **Cost:** a second orchestration path, and a **weaker isolation model** — one shared daemon
  instead of a VM per project (port collisions, no shared-nothing boundary). That's a downgrade
  of the fork's whole premise, so the `docker` backend is a **dev/CI** backend, not a production
  substitute.
- **Tests:** the container/docker layer + wrapper *logic* — **not** the real Colima orchestration.

## Approach 2 — proxy host commands to the Mac (keep one code path)

Instead of a second backend, keep the **single Colima code path** and, when it runs inside a
container, **proxy the host-only commands out to the Mac**, where the real Colima runs.

**Realization — PATH shims + a host agent (no framework changes):**

- Bake shim binaries named **`colima`** and **`limactl`** early on the container's `PATH`. Each
  shim forwards its `argv` to a **host agent** on the Mac, which runs the real command and
  streams back stdout/stderr/exit. On the Mac there are no shims → `colima` is the real binary →
  **passthrough**. `wrapper.sh` is untouched (it just calls `colima`).
- The agent is reachable over the **Colima gateway `192.168.64.1`** — the exact pattern the
  [CDP bridge](browser-testing.md) already uses (host-side helper, VM-reachable, not LAN-exposed).
- It composes with an existing invariant: the workspace is mounted at the **same path** on Mac
  and container, so a proxied command that touches the workspace sees the same files.

- **Delivers (more than Approach 1):** a dev claudebot drives the **real Colima** — real
  per-project VMs, reachable IPs, `vm gc`, reseed — so the **full orchestration path** is under
  test end-to-end from inside a container. No reimplementation, no isolation downgrade.

### The wrinkle: the surface is Colima **and** Docker

`wrapper.sh` doesn't only call `colima`; it calls **`docker --context colima-cb-<id>`** to
build/run *into* those VMs. From the container, those contexts live on the Mac — so a
context-targeted `docker` has to be proxied too. In practice that means also shimming `docker`,
which makes the container a fairly **thin client** for the Mac's Colima + Docker. (A first cut
can defer the `docker` shim and prove the `colima`-only path first.)

### Security model (this is the real cost)

A shim that proxies commands to the Mac **is remote host command execution from a container.**
Proxying `docker` is nearly *"the container can run anything on the Mac"* (`docker run -v
/:/mac --privileged …` ⇒ full host access); even `colima`/`limactl` can delete VMs and mount
host paths. So the agent MUST be:

- **Opt-in, off by default** — enabled only for the deliberate "develop the harness in a dev
  dridock" use case, never a general claudebot capability.
- **Bound to `192.168.64.1` only** — the Colima gateway the project VMs reach; **never**
  `0.0.0.0`/LAN. Torn down when not in use (like the CDP bridge).
- **Token-authenticated per session** — a secret the wrapper injects, so a random VM neighbour
  can't drive it.
- **Command-allowlisted** where feasible — trivial for `colima`/`limactl` (fixed subcommands);
  genuinely hard for `docker` (unbounded `run` flags), which is why the `docker` shim is the
  sharpest edge.

**Realistic framing:** this is a **trusted, single-operator tool** — appropriate for *you*
driving your own harness dev from your own dev dridock, not something to ship enabled for
arbitrary projects/claudebots.

## The two are complementary, not rivals

| | **Approach 2 — proxy-to-host** | **Approach 1 — docker backend** |
|---|---|---|
| Tests | the **full** framework incl. real Colima | container/docker layer + wrapper logic |
| Isolation | real per-project VMs (unchanged) | shared daemon (weaker) |
| Reimplements Colima? | no — drives the real one | partially (docker equivalents) |
| Security | **high** (remote host exec) → opt-in, trusted-only | low (self-contained) |
| Best for | Alan driving the real thing from a dev dridock | Linux CI / other contributors |

## Recommendation

- For **"Alan develops the harness end-to-end inside a dridock, against real Colima"** →
  **Approach 2 (proxy)**, built as a tight opt-in agent (gateway-bound, token-auth, reusing the
  CDP-bridge machinery), accepted as a trusted capability. Start **colima-only** (defer the
  `docker` shim) to keep the first cut's blast radius small.
- For **safe Linux CI / contributors without a Mac** → **Approach 1 (docker backend)**.
- They can coexist: the proxy for powerful trusted dev, the docker backend for CI.

## Phasing (proxy)

1. ✅ **Host agent** (`host-agent.py`) — daemon on the Mac (reusing the CDP bridge's gateway-bound
   pattern), **token-auth + binary/subcommand allowlisted**, streams an allowlisted `colima`/
   `limactl`. Control with **`dridock host-agent up|down|status`** (opt-in, off by default).
2. ✅ **`colima`/`limactl` shims** (`cb-host-shim`, baked as both) proxy the framework's calls to
   the agent; the wrapper injects the agent URL+token (durable `-hostagent` sidecar, empty when
   the agent is down). Proven: a bridge-network container ran real `colima list` on the Mac.
3. ✅ **The `docker` decision — resolved as "docker LOCAL, not proxied" (v2.15.0).** A `docker`
   shim proxying to the Mac was rejected: it's near-full host compromise (`docker --context
   colima-cb-X run -v /:/mac …` on the Mac) for little gain. Instead `make build` and
   `tests/common.sh` are **backend-aware** (`DRIDOCK_BACKEND`, auto `docker` inside a
   container): in `docker` mode they build the image and run the integration tests on the dev
   claudebot's **own** VM daemon — no colima, no host proxy. So a dev claudebot can `make build`
   + `bash test.sh` end-to-end. The phase-1 host-agent stays for the narrow slice that genuinely
   needs *real* Colima (e.g. exercising `dridock vm gc` against live VMs).
4. ⬜ A "develop-the-harness-in-a-dridock" runbook. And note (confirmed): much of it needs **no
   proxy at all** — unit tests (`test_cbvm.sh`, `test_bootstrap.sh`) are pure bash and run
   anywhere; the integration suite is `docker build`/`run` that the local daemon satisfies. The
   host-agent is only for the Colima-*orchestration* tests.

### The docker backend for build/test (phase 3)

`DRIDOCK_BACKEND = colima | docker` (auto: `docker` when `/.dockerenv` exists) selects where
`make build` and the integration tests run:

| | `colima` (Mac/prod) | `docker` (CI / in-container) |
|---|---|---|
| `make build` | `colima start cb-infra` + `docker --context colima-cb-infra build` | `docker build` on the ambient daemon |
| `tests/common.sh` | throwaway `colima` test VM + build/run in its context | build/run on the ambient daemon (no VM) |

This is **not** the docker *shim* (no host proxy) — it's the same-machine ambient daemon the dev
claudebot already has. Overridable: `make build DRIDOCK_BACKEND=docker`, `DRIDOCK_BACKEND=docker bash test.sh`.

### How to use phase 1
On the Mac: `dridock host-agent up` (prints a trust warning). Restart your harness-dev
claudebot so it picks up the injected agent URL/token. Inside it, `colima list` (and other
allowlisted `colima`/`limactl` subcommands) now execute on the Mac. Stop with
`dridock host-agent down`. It is **off by default** and a **trusted single-operator tool** —
do not enable it for arbitrary projects.

## Open questions

- Can most harness dev be done with **no proxy at all** — unit tests (`test_cbvm.sh`, pure bash)
  run anywhere, and much of the integration suite is `docker build`/`run` that a local daemon
  satisfies? If so, the proxy is only needed to exercise Colima *orchestration* specifically,
  which narrows its scope (and its risk) considerably.
- Is the `docker` shim worth its security cost, or is "Colima proxied, docker local" enough?

## See also

- [developing-in-a-claudebox.md](developing-in-a-claudebox.md) — the **runbook**: the actual dev loop this enables (build/test the harness in a container).
- [framework-dev-mode.md](framework-dev-mode.md) — the runtime mode + convention for framework-dev-only harness code that this backend makes possible.
- [per-project-vm.md](per-project-vm.md) — the Colima model both approaches work around.
- [browser-testing.md](browser-testing.md) — the CDP bridge's host-agent pattern the proxy reuses (gateway-bound, token-auth ethos).
- [../../CLAUDE.md](../../CLAUDE.md) — the DooD orchestration vision (Container 1 spinning up Container 2/3).
- [versioning.md](versioning.md) — where a `DRIDOCK_BACKEND` contract change would land.

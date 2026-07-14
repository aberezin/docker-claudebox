# claudebox

**A sandbox for Claude Code that makes `--dangerously-skip-permissions` reasonably safe. **

Give Claude Code its own project-scoped Colima VM on your Mac. Every project is
shared-nothing — its own daemon, its own images, its own network, its own
credentials — so you can let the agent run fully autonomous without it ever
touching your Mac or another project's data.

Built on Anthropic's Claude Code CLI. Fork of [psyb0t/docker-claudebox](https://github.com/psyb0t/docker-claudebox),
re-targeted for Colima with per-project isolation and multi-container
orchestration.

---

## The problem

You want to run Claude Code with `--dangerously-skip-permissions` so it can
edit, build, run, and iterate without asking permission every step. That's
where the productivity is. But on a bare Mac that means Claude has your
shell, your SSH keys, your git creds, your whole home directory. One bad
prompt-injection, one confused refactor, one runaway shell loop, and your
laptop is the collateral damage.

The usual answer is "put it in a container." That helps — but if you use
a devcontainer or `docker run`, every project you start shares **one** Docker
daemon. The container's mounted socket sees every other container on your
Mac. `~/.claude` credentials are one `docker cp` away. Two projects publishing
port 8080 collide. And when Claude decides to spin up test workloads
(API + database + browser), they land as siblings on that shared daemon too.

claudebox draws the isolation boundary one level up: **every project gets its
own Colima VM**.

---

## What claudebox actually gives you

Concretely, when you `cd` into a project and type `claudebox`:

- A dedicated Colima VM (`cb-<project-id>`) boots for that project. First
  time takes ~30–60s; after that it's warm.
- A container starts inside that VM running Claude Code with
  `--dangerously-skip-permissions` and the docker socket of *that VM*.
- Your project directory is mounted at the same path inside the container as
  on your Mac (so paths just work, and files come back owned by you).
- Anything Claude spins up — test API, database, headless browser — lands as
  a sibling on that VM's docker daemon. Those siblings are on a shared
  network (`cb-net`) and reach each other by container name.
- The VM has its own reachable IP (`192.168.64.x`), and any workload that
  publishes a port is browsable from your Mac at that IP — collision-free
  with every other project's VM.

That's the whole model. Everything below flows from it.

---

## What's different from the alternatives

### vs. running Claude Code directly on macOS

The gap is `--dangerously-skip-permissions`. On bare Mac, the flag hands
Claude your shell. If you don't set the flag, you're clicking "yes" on
every command, which is the productivity you were trying to get. Everything
below is about closing that gap without giving up the flag.

### vs. upstream `psyb0t/docker-claudebox`

The upstream project allows running Claude Code in a container, and this
fork keeps its interfaces (interactive, programmatic, HTTP API,
OpenAI-compatible, MCP, Telegram bot, cron). What this fork adds:

- **Per-project VM** instead of one shared Docker daemon. In upstream, every
  project's claudebot sees every other project's containers via the shared
  socket.
- **DooD orchestration** into a project-scoped daemon. Claude can spin up
  a full multi-tier test app (API + db + browser) and those workloads are
  quarantined to the project's VM.
- **A published n-tier networking standard** so multi-container apps built
  by different Claude sessions in different projects behave the same way.
- **Local build only** — no Docker Hub pull.

### vs. Devcontainers / Anthropic's official Claude Code devcontainer

Devcontainers give you per-project *container* isolation, which stops Claude
from touching your Mac filesystem — that's real. What they don't give you:

- **The docker daemon is shared with your host and every other devcontainer.**
  If the container has the docker socket mounted (needed for anything that
  builds or runs sibling containers), it can enumerate, inspect, and `docker
  cp` every other container on your machine — including their mounted
  `~/.claude` credentials. This is a well-documented risk with
  `--dangerously-skip-permissions` in devcontainers.
- **Cross-project bleed on ports and image cache.** Two projects on port
  8080 collide; a `docker system prune` in one wipes another's build cache.
- **Multi-container app orchestration is a project you build yourself.** No
  standard for how the browser reaches the app you're testing, no
  rotating-IP handling, no per-project network.

claudebox does not eliminate every risk devcontainers have (a compromised
Claude can still exfiltrate what's inside its own container — its own
`~/.claude`, its own SSH key). It puts a hard boundary between projects and
between a project and the Mac.

### vs. GitHub Codespaces

Codespaces gives you a full remote VM per repo — the strongest isolation on
this list. The tradeoffs are latency, cloud spend, cold-start time, and that
your dev environment now lives on someone else's server. claudebox is the
local equivalent for when you want the isolation without the roundtrip.

### vs. ad-hoc `docker run` with the Claude Code image

Same problems as devcontainers, minus the good IDE integration. Fine for a
one-off; painful as a workflow.

---

## Key Callouts

### 1. Per-project isolation is at the VM level, not the container level

Every `claudebox` project gets its own Colima profile (`cb-<id>`), which
means its own Lima VM, its own `dockerd`, its own docker context, its own
network. A Claude session working in project A cannot see, list, kill, or
`docker cp` anything in project B — not because of a wrapper policy the
agent could bypass, but because it's a different daemon on a different VM.

The macOS `default` Colima profile is reserved for you and never touched by
claudebox.

Design: [per-project-vm.md](../design/per-project-vm.md).

### 2. `--dangerously-skip-permissions` is architecturally safe here

The flag is always on inside the container. That's intentional — the
container-in-a-project-VM is the isolation boundary, so Claude can move
freely inside it. The boundary holds because:

- The container can't reach your Mac filesystem (only the mounted workspace,
  which comes back owned by you).
- The container's docker socket points at *its own project's* VM, not the
  Mac's docker or another project's.
- A compromised session in project A cannot enumerate or touch project B.
- Credentials (`~/.claude`) are per-project — not a shared global directory.

### 3. Docker-out-of-docker for real multi-tier test workloads

Claude often needs to spin up a full app to test its own changes: an API,
a database, a headless browser. In claudebox, `docker run` inside the
container talks to the project VM's daemon, so those workloads:

- Are real sibling containers with native performance (no nested VM tax).
- Share a network (`cb-net`) and address each other by container name.
- Publish ports that are browsable from your Mac at the project's own VM IP.
- Are automatically isolated from every other project.

There's a published standard for multi-tier apps under this model — how
tiers address each other (service plane vs browser plane), the rotating VM
IP, CORS/allowed-origins from `$CLAUDEBOX_VM_IP` — so every Claude session
in every claudebox project builds them the same way.

Design: [n-tier-networking.md](../design/n-tier-networking.md).

### 4. The edge cases are worked out

The stuff that trips up any "put Claude in a container" setup, worked out
and baked in:

- **Rotating VM IPs self-heal.** Colima VMs get a new IP on restart. The
  wrapper injects `$CLAUDEBOX_VM_IP` fresh on every launch, so hardcoding
  it in `next.config.ts` or CORS allowlists (a top cause of "worked
  yesterday") isn't necessary.
- **Disk starvation is diagnosed and recoverable.** The VM's overlay disk
  is shared between docker images and the Claude Code Bash tool's `/tmp`;
  when docker fills it, `ENOSPC` kills every shell command including the
  bug-report tool. There's a runbook (`cb-df`, `CLAUDEBOX_PRUNE_ON_START`,
  a Write-tool escape when Bash is down, `claudebox vm gc` from the Mac)
  and it's built into the claudebot's baked guidance so it self-diagnoses.
- **Secrets never touch the command line.** Credentials live in a
  gitignored `.claudebox/secrets.env` (chmod 600), get re-injected on every
  container start, and survive `docker start` (which normally can't take
  new env). The pattern is enforced end-to-end and baked into the guidance
  Claude follows inside every project.
- **A feedback loop back to the framework.** When the container's tooling
  gets in Claude's way, `cb-report-bug` files a durable report; when a
  design pattern is missing, `cb-consult` opens a human-mediated
  conversation with the Claude session that maintains the framework, and
  the resolution ships as a new baked standard for every project.

Design docs: [disk-management.md](../design/disk-management.md) ·
[framework-consult.md](../design/framework-consult.md).

---

## Quick start

You need macOS with [Colima](https://github.com/abiosoft/colima) and Docker
CLI, plus one-time passwordless-sudo setup for `socket_vmnet` (so VM starts
don't prompt for your password).

```bash
# install colima + docker + socket_vmnet, then one time:
limactl sudoers | sudo tee /etc/sudoers.d/lima

# clone and install (builds the image locally, no docker hub pull)
git clone <your-fork-url> claudebox && cd claudebox
./install.sh

# scaffold a project with a mission brief
mkdir project-a && cd project-a
claudebox bootstrap "Build a 3-tier app: React UI, Node API, Postgres."

# or drop into interactive mode in an existing repo
cd my-existing-repo
claudebox
```

First run in a project boots the VM (~30–60s) and starts Claude. Subsequent
runs reuse the warm VM.

Full setup: [README](../../README.md).

---

## When claudebox is not the right choice

- **You're on Windows or Linux.** claudebox targets macOS + Colima
  specifically. Upstream `docker-claudebox` is Docker Desktop-agnostic and
  fits a Windows/Linux workflow better.
- **You don't want the VM overhead.** A dedicated VM per project reserves
  CPU/RAM when running (4 CPU / 8 GiB / 100 GiB disk by default — tunable
  per project; VM disks are sparse, so the 100 GiB cap costs no Mac disk
  until used). Ten simultaneous projects on a 16 GB Mac isn't the target.
  The `hard_max` cap is 5 concurrent VMs by default.
- **You want the same container to hit multiple projects.** claudebox is
  shared-nothing. Cross-project image caches, shared global `~/.claude`,
  and shared workload networks are non-goals.
- **You want your Claude to touch things outside its project.** The
  boundary is the point. If your workflow needs the agent to reach a
  neighboring repo, a shared image, or your Mac's own Docker daemon,
  you're fighting the design.

---

## Where to go next

- **[README](../../README.md)** — installation, image variants, modes, and configuration.
- **[Per-project VM design](../design/per-project-vm.md)** — how the isolation model is built.
- **[N-tier networking standard](../design/n-tier-networking.md)** — how Claude builds multi-container apps under this model.
- **[Disk management](../design/disk-management.md)** — the ENOSPC runbook.
- **[Bootstrap](../design/bootstrap.md)** — creating a project with a mission brief.
- **[CHANGELOG](../../CHANGELOG.md)** — the 2.x fork's history.

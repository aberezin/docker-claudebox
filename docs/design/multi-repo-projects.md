# Multi-repo projects (one dridock project, N repos)

The flat "one repo = one dridock project" layout is ideal for a single repo or a
monorepo. But many projects span **several repos** — a frontend, a backend, an infra
repo, shared libraries. This describes how to structure those without fighting the
tooling.

## The model: the project is the *workspace*, not a repo

dridock's isolation boundary is the **project / VM**, not the git repo. A project is
a **directory** with a `.dridock/` and its own per-project Colima VM; the claudebot
mounts that directory and works inside it. So an N-repo project is **one** dridock
project whose workspace *contains* the N repos as siblings:

```
myproject/                 ← the dridock project (.dridock/ here; ONE VM, one claudebot)
├── .dridock/              ← id, config.yml, BRIEF.md (the multi-repo mission)
├── frontend/              ← repo 1 (its own .git, own remote)
├── backend/               ← repo 2 (its own .git, own remote)
├── infra/                 ← repo 3 (its own .git, own remote)
└── docker-compose.yml     ← orchestration the claudebot uses to wire the services up
```

One VM, one claudebot, all repos in view — it can change code across them, build an
image per service, and run them together.

## Why not N separate dridock projects?

Because the fork is **shared-nothing per VM** (see [per-project-vm.md](per-project-vm.md)).
If each repo were its own dridock project, each claudebot would run in its own VM and
be **blind to the other repos** — no cross-repo edits, no coordinated build/run, and N
VMs of overhead. Cross-*project* isolation is the point; a coherent multi-repo system is
**one** project.

## The one gotcha: don't let the parent *track* the sub-repos

The layout above looks like a nested-git tangle (the failure mode a real project hit —
an empty wrapper repo "containing" an app repo, producing gitlink confusion). The fix is
about **what the parent's git tracks**, and there are two clean choices:

1. **Parent is NOT a git repo** — just a workspace folder. Simplest. Orchestration files
   and `BRIEF.md` live there, unversioned (`config.yml` is machine-local/gitignored
   anyway). Good when the repos are the only things worth versioning.

2. **Parent IS a small "orchestration repo" that gitignores the app-repo dirs** — you
   version your `docker-compose.yml`, scripts, ADRs, and `BRIEF.md`, while `.gitignore`
   excludes `frontend/`, `backend/`, … so git never tries to track them as nested repos
   (gitlinks). This is usually the sweet spot: versioned orchestration, no gitlink hell.

   ```gitignore
   # parent orchestration repo: ignore the checked-out app repos
   /frontend/
   /backend/
   /infra/
   /.dridock/config.yml
   /.dridock/secrets.env
   ```

**Avoid:** a parent git repo that `git add`s the sub-dirs — that creates broken
gitlinks (submodule-like entries with no submodule config). If you *want* pinned repo
revisions, use real **git submodules** (formal, more overhead) rather than accidental
gitlinks.

## Orchestration is the core use case

A multi-repo project is exactly the "Project-A: three-tier app in containers" scenario
in the top-level `CLAUDE.md`. The claudebot:

- builds a **self-contained image per service** (each repo has a Dockerfile; `COPY` the
  code in — don't bind-mount, the VM daemon can't see the host workspace path),
- runs them on the shared **`cb-net`** network so they reach each other by container
  name (`http://backend:8080`),
- publishes ports so the human reaches them at the **project VM's IP** (`dridock ip`),
  collision-free across projects.

The per-project VM gives the whole multi-repo system one clean, disposable sandbox.

## Setting one up — `bootstrap --workspace`

First-class tooling: **`--workspace`** makes the current dir a multi-repo orchestration
parent, and repeatable **`--repo <url>`** clones each as a gitignored sibling (so the
parent never tracks them as gitlinks):

```bash
mkdir -p ~/Development/myproject && cd ~/Development/myproject
dridock bootstrap --workspace \
  --repo <frontend-url> --repo <backend-url> --repo <infra-url> \
  "myproject spans frontend + backend + infra — <goal>"
# → git init parent (orchestration, NO workloads/), README, multi-repo BRIEF,
#   .gitignore excluding /frontend/ /backend/ /infra/ + machine-local config/secrets,
#   and the three siblings cloned. Then it boots one VM; the claudebot sees all three.
```

`--workspace` alone sets up the parent without cloning (add repos yourself — they're
auto-gitignored as `--repo` adds them). Each `--repo <url>` takes a URL or `gh owner/repo`
and uses the host's git/`gh` auth (add `--gh-token` for private repos). State each repo's
role + wiring in `.dridock/BRIEF.md` (the generated multi-repo section prompts for it) so
any later session picks up the topology.

> `--workspace` and `--adopt` are mutually exclusive: `--adopt` is *one existing repo IS the
> workspace*; `--workspace` is *a parent holding N sibling repos*. See [bootstrap.md](bootstrap.md).

## See also

- [per-project-vm.md](per-project-vm.md) — the project/VM isolation model this builds on.
- [bootstrap.md](bootstrap.md) — how a project + BRIEF are scaffolded.
- [convenience-scripts.md](convenience-scripts.md) — the `cb-*` tools the claudebot uses.
- The top-level `CLAUDE.md` — the orchestration/networking standard (`cb-net`, VM IP).

# Multi-repo projects (one claudebox project, N repos)

The flat "one repo = one claudebox project" layout is ideal for a single repo or a
monorepo. But many projects span **several repos** — a frontend, a backend, an infra
repo, shared libraries. This describes how to structure those without fighting the
tooling.

## The model: the project is the *workspace*, not a repo

claudebox's isolation boundary is the **project / VM**, not the git repo. A project is
a **directory** with a `.claudebox/` and its own per-project Colima VM; the claudebot
mounts that directory and works inside it. So an N-repo project is **one** claudebox
project whose workspace *contains* the N repos as siblings:

```
myproject/                 ← the claudebox project (.claudebox/ here; ONE VM, one claudebot)
├── .claudebox/            ← id, config.yml, BRIEF.md (the multi-repo mission)
├── frontend/              ← repo 1 (its own .git, own remote)
├── backend/               ← repo 2 (its own .git, own remote)
├── infra/                 ← repo 3 (its own .git, own remote)
└── docker-compose.yml     ← orchestration the claudebot uses to wire the services up
```

One VM, one claudebot, all repos in view — it can change code across them, build an
image per service, and run them together.

## Why not N separate claudebox projects?

Because the fork is **shared-nothing per VM** (see [per-project-vm.md](per-project-vm.md)).
If each repo were its own claudebox project, each claudebot would run in its own VM and
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
   /.claudebox/config.yml
   /.claudebox/secrets.env
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
- publishes ports so the human reaches them at the **project VM's IP** (`claudebox ip`),
  collision-free across projects.

The per-project VM gives the whole multi-repo system one clean, disposable sandbox.

## Setting one up

Until first-class tooling lands (see below), the manual flow:

```bash
mkdir -p ~/Development/myproject && cd ~/Development/myproject
claudebox bootstrap "myproject spans repos: frontend, backend, infra — <goal>"
# make the parent an orchestration repo that ignores the app checkouts (or skip git here):
printf '/frontend/\n/backend/\n/infra/\n' >> .gitignore
git clone <frontend-url> frontend
git clone <backend-url>  backend
git clone <infra-url>    infra
claudebox            # one VM; the claudebot sees all three repos
```

State each repo's role and the wiring in `.claudebox/BRIEF.md` so any later session
picks up the topology.

## Not yet: first-class multi-repo bootstrap (task #13)

`claudebox bootstrap` scaffolds a single project and `git init`s the parent, which for
multi-repo is the *start* of the gitlink footgun unless you gitignore the sub-repos. A
`bootstrap --workspace` (or `--multi-repo`) mode should: set the parent up as an
orchestration repo (or leave it plain), seed a `.gitignore` that excludes the sibling
app-repo dirs, and record the repo topology in the BRIEF.

## See also

- [per-project-vm.md](per-project-vm.md) — the project/VM isolation model this builds on.
- [bootstrap.md](bootstrap.md) — how a project + BRIEF are scaffolded.
- [convenience-scripts.md](convenience-scripts.md) — the `cb-*` tools the claudebot uses.
- The top-level `CLAUDE.md` — the orchestration/networking standard (`cb-net`, VM IP).

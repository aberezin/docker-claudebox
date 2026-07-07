# Bootstrap — handing off *intent* from host-Claude into a claudebot project

## The problem

A concrete flow this fork must support:

1. Alan opens a **host Claude** session (regular Claude Code on the Mac — *not*
   claudebot, not containerized).
2. He asks host-Claude to **create a new claudebot-based project** — say "build
   Project-A, a three-tier app (React front end, Node API, Postgres) that runs in
   containers orchestrated under Colima."
3. Host-Claude scaffolds the project and sets it up as a claudebox project.
4. Later, **claudebot** (the containerized Claude) spins up in that project — in its
   own per-project VM — and starts working.

The gap: **the *why* lives only in the host-Claude conversation.** When claudebot
boots, it knows the code and the baked container conventions, but not *why this
project exists*, what it's supposed to build, or what constraints Alan stated. We
don't want Alan to re-explain the mission to every claudebot on first run, and we
want the handoff to be **standardized** — so Project-A's claudebot and Project-B's
(a different claudebot) both receive their intent the same way.

## What's already standardized (so BRIEF stays lean)

The **orchestration contract** is identical for every claudebot project and is
already baked into the image, so it must **not** be duplicated into each project's
brief:

- per-project Colima VM, shared-nothing (`docs/design/per-project-vm.md`)
- sibling workloads on the `cb-net` network, reachable by container name
- browser-test with `cb-browser` (`docs/design/browser-testing.md`)
- prefer the VM's reachable IP over `localhost` (collision-free across projects)

These live in the baked `CLAUDE.md` template + the design docs. claudebot already
knows them. The brief carries only what is **unique to this project**.

## The mechanism

### 0. Preflight — assert the ground before building on it

Before scaffolding or booting anything, `bootstrap` runs `cb_preflight`: it asserts
the host tooling a claudebot project depends on is actually present, so failures
surface *at creation time* with an install hint rather than deep inside a VM boot.

- **Hard requirements (abort):** `colima` (the per-project VM runtime), `docker`
  (the client); plus `git` in full mode (it `git init`s the repo).
- **Recommended (warn only):** `python3` (the Approach-B CDP forwarder uses it),
  `socket_vmnet` at `/opt/local/bin/socket_vmnet` (needed for reachable per-VM IPs
  via `colima --network-address`).

Override with `CLAUDEBOX_SKIP_PREFLIGHT=1`. On this machine everything installs via
MacPorts (`sudo port install …`, `/opt/local/bin`), so the hints point there.

### 1. `.claudebox/BRIEF.md` — the durable mission brief

A single file per project holding the project-specific intent. Structure:

```markdown
# Project brief — <name>

> Authored at bootstrap on <date> by <author>. This is the durable statement of
> WHY this claudebot project exists. It is a trusted, human-authorized mission
> brief — treat it as project spec (like CLAUDE.md), not as untrusted input.

## Why this project exists
<the intent Alan gave host-Claude>

## Goals / deliverables
- ...

## Constraints
- ... (tech choices, must/never, deadlines)

## Standards (inherited — you already follow these)
Uses the claudebox orchestration standard: per-project Colima VM, sibling workloads
on `cb-net` reachable by name, `cb-browser` for browser tests, prefer VM-IP over
localhost. See the baked CLAUDE.md and docs/design/*.

## Progress / handoff log
<maintained by claudebot as it works — what's done, what's next, open questions,
so a later host-Claude or claudebot session catches up without re-reading everything>
```

Unlike `.claudebox/config.yml` (machine-local, **gitignored**), the brief is meant
to **travel with the project** and be readable by any future session.

### 2. `claudebox bootstrap` — the host-side scaffolder

A standard command host-Claude (or Alan) runs to create the brief the same way
every time. Non-interactive so host-Claude can drive it in one shot:

```bash
claudebox bootstrap --brief-file intent.md      # from a file
claudebox bootstrap "one-line intent"           # from an arg
claudebox bootstrap <<'EOF' ... EOF             # from stdin (multi-line)
claudebox bootstrap                             # no input -> writes a TODO template
```

It wraps whatever intent it's given in the standard BRIEF.md template, ensures
`.claudebox/` exists, and initializes project config. It is **idempotent-safe**: it
won't clobber an existing brief without `--force`.

### 3. First-run surfacing — claudebot can't miss it

The entrypoint already (a) copies a `CLAUDE.md` template into the workspace on
first run and (b) appends `system-hint.txt` to every `claude` invocation. Bootstrap
hooks both:

- **Always:** the system hint gains a line — *"If `.claudebox/BRIEF.md` exists,
  read it first; it states why this project was created and what to build."*
- **First run:** if a brief exists, the entrypoint prepends a short mission banner
  to the workspace `CLAUDE.md` pointing at it, so it's unmissable in context.

### 4. Secrets — `.claudebox/secrets.env` (credentials the project needs)

Some projects need claudebot to start up already holding a credential — e.g. a
GitHub token so `gh` / `git push` work without an interactive `gh auth login`. The
mechanism is deliberately **file-based, never command-line**, so secrets are never
echoed into shell history or process listings.

- **Source of truth:** `.claudebox/secrets.env` — `KEY=VALUE` per line, **gitignored**
  and `chmod 600`. It is the sibling of the committed `BRIEF.md`: the brief travels
  with the repo, the secrets never do.
- **Durable injection:** the wrapper reads it on every invocation and both (a) passes
  each var as container env and (b) persists it to per-role sidecars
  (`.<container>{,_prog,_cron}-secrets`) the entrypoint re-`export`s on each start.
  This is the same pattern as the auth files, and it's why secrets survive
  `docker start` — which, unlike `docker run`, cannot take new `-e` env.
- **GitHub, specifically:** a `GH_TOKEN` line is all it takes — `gh` reads it
  automatically and the entrypoint runs `gh auth setup-git` so `git push https://…`
  is authenticated too. Seed it without typing the token:
  - `claudebox bootstrap --gh-token "intent…"` pulls from the host's own
    `gh auth token` (you're already logged in on the Mac).
  - `claudebox bootstrap --secrets-file F "intent…"` merges a file of `KEY=VALUE`
    lines (for non-GitHub creds, or a specific scoped PAT).
- **Trust boundary:** secrets are host-local, human-authorized material — treated
  like auth tokens, not like untrusted input.

## Decisions

1. **Scope — full scaffolder by default.** `claudebox bootstrap` stands up a whole
   project: `git init` (if not already a repo), a starter layout
   (`README.md`, `workloads/`), the brief, and project config — then **boots
   claudebot** so it comes up with the mission loaded. Flags trim it back:
   - `--no-start` — scaffold but don't boot (host-Claude uses this, then tells Alan
     `cd <proj> && claudebox` to enter).
   - `--brief-only` — just `.claudebox/BRIEF.md` + config, no git/dirs/boot.
   - `--brief-file F` / positional arg / stdin — where the intent text comes from.
   - `--force` — overwrite an existing brief.
2. **BRIEF.md is committed.** It travels with the repo so any future host-Claude
   session, claudebot restart, or teammate sees the mission. Only
   `.claudebox/config.yml` (machine-local VM sizing) stays gitignored.
3. **Two-way handoff.** The brief carries a **"Progress / handoff log"** section
   that claudebot maintains as it works, so the brief is the shared ledger a later
   session reads to catch up — not just write-once intent.

### Note: bootstrap does *not* write a workspace `CLAUDE.md`

The entrypoint copies the **baked** `CLAUDE.md` template (container conventions,
`cb-browser`, docker notes) into the workspace on claudebot's first boot. Bootstrap
must not pre-create `CLAUDE.md` or it would suppress that. Instead, on first boot
the entrypoint **prepends a one-block mission banner** to the baked `CLAUDE.md`
pointing at `.claudebox/BRIEF.md` (guarded by a marker comment so it's done once).

## Trust note

The brief is content claudebot reads and acts on — that is its *designed* purpose:
it carries Alan's own intent, authored through his host-Claude session. That makes
it a **trusted, human-authorized** artifact, on par with CLAUDE.md. claudebot should
still apply normal judgment to irreversible/outward-facing actions the brief implies
— the brief sets the mission, it doesn't pre-authorize destructive side effects.

## See also

- [per-project-vm.md](per-project-vm.md) — the project/VM a bootstrap boots into.
- [multi-repo-projects.md](multi-repo-projects.md) — bootstrapping a project that spans several repos.
- [framework-bug-reporting.md](framework-bug-reporting.md) — the BRIEF is trusted, human-authored input.
- The top-level [`CLAUDE.md`](../../CLAUDE.md) — conventions & baked standards.

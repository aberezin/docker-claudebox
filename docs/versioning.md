# Versioning & releases

This fork uses [semantic versioning](https://semver.org) on its **own** version
line, starting at **2.0.0** (2026-07-06). We deliberately start **above** upstream
claudebox's highest pre-fork tag (`v1.11.0`) so the fork's versions and tags never
collide with the inherited upstream history and sort cleanly above it — which also
keeps things coherent if upstream ever pulls from us or we pull from them. Upstream's
`1.x` history is preserved in `CHANGELOG.md` below the fork's entries.

## Why a version matters here

The host wrapper (`wrapper.sh`, installed as `dridock` in 3.0+ — was `claudebox` in 2.x) and the built image
(entrypoint + baked helpers like `cb-browser`) share an **IPC contract**: sidecar
filenames/formats (`.<container>-auth` / `-secrets` / `-args` / …), forwarded env,
the `cb-browser` `/out` convention, secrets injection. If they drift — you update
one but not the other — you get subtle, confusing breakage. The version makes drift
**detectable**.

## Source of truth

- **`VERSION`** (repo root) holds the current semver — the single source of truth.
- **`wrapper.sh`** embeds it as `DRIDOCK_VERSION` (3.0+; was `CLAUDEBOX_VERSION` in
  2.x); a unit test (`tests/test_cbvm.sh`) asserts the two match, so they can't
  silently diverge.
- The **image** stamps it at build time via `Dockerfile` `ARG`/`ENV`/`LABEL
  org.dridock.version` (3.0+; the `checkversion` reader still falls back to the
  legacy `org.claudebox.version` label for one deprecation cycle), passed by
  `make` / `install.sh` as `--build-arg DRIDOCK_VERSION=…`.

## Checking for drift

- `dridock version` — print the host wrapper's semver.
- `dridock checkversion` — compare the wrapper against the version baked into the
  claudebot image (both the `cb-infra` build/store image and this project's VM), and
  warn on drift with direction-specific guidance (rebuild the image / reinstall the
  wrapper). Read-only; never boots a VM. Images built before versioning read as
  `unstamped` until the next `make build`.
  It also lists **every variant tag** in cb-infra (`latest` and `latest-minimal`),
  marks the one dridock runs, and flags any whose harness version lags the wrapper or
  whose `org.dridock.claude-version` differs from the checkout's `ARG CLAUDE_VERSION`,
  or is missing, which means the image predates #78. Before #109 it looked at
  `dridock:latest` only, and said "in sync" on a host whose minimal image was ten
  releases behind.

## When to bump (semver)

- **PATCH** (`2.0.0 → 2.0.1`) — fixes/docs, no contract change.
- **MINOR** (`2.0.0 → 2.1.0`) — new features, **or a backward-compatible (additive)
  change to the host↔container IPC contract**: a new sidecar file / forwarded env /
  baked helper that a newer peer adds and an older peer safely ignores (e.g. adding
  the `-secrets` sidecar).
- **MAJOR** (`2.0.0 → 3.0.0`) — a **breaking** contract change: a renamed/removed
  sidecar, or a changed format/semantics an older peer would misread. This is what
  `checkversion`'s drift warning most wants to catch.

## Release steps

1. Bump **`VERSION`** and the `DRIDOCK_TS_VERSION` constant in **`dridock-ts/src/domain/dridockVersion.ts`** to the
   same value. `tests/test_version_sync.sh` enforces it — until #103 that line
   claimed a "sync test" which did not exist, so the two could silently diverge
   and the first symptom was `dridock checkversion` reporting host↔image drift
   at runtime, long after the commit that caused it.
2. Add a **`CHANGELOG.md`** entry under a new `## [X.Y.Z] - <date>` heading — one
   entry per bump (see the changelog policy below). **Keep `## [Unreleased]`**:
   the new heading goes directly **below** it, with any entries that were waiting
   under `Unreleased` moved into the release. Don't rename `Unreleased` to the
   version. `dridock harness update-cli` writes under that heading; the 5.13.0
   cut renamed it and #105 had to restore it (#106). `update-cli` now puts a
   missing one back, but `tests/test_version_sync.sh` fails unless there is
   exactly one, above every release heading.
3. Commit **on a branch** — `master` refuses direct commits (see
   [Release branches](#release-branches-release-xyz) for which name to use) —
   then ff-merge and **tag** the merged commit: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push it
   (`git push <remote> vX.Y.Z`). **Fork gotcha:** the clone inherited upstream's
   `v0.x`–`v1.x` tags locally, so `git tag vX.Y.Z` may collide with an ancient
   upstream tag pointing at the wrong commit. Verify with `git rev-list -n1 vX.Y.Z`,
   and use `git tag -f -a vX.Y.Z HEAD` (then `git push --force <remote> vX.Y.Z`) if it
   resolved to an upstream commit. The remote fork only carries the tags we push.
4. `./install.sh` to stamp both images (full and minimal, #111) and reinstall the
   binary. `dridock checkversion` should then read **in sync** for both variants.

## Branch naming — `<issue#>-<slug>`

Work branches are named for the **GitHub issue they close**, issue number first:

```
62-mcp-pin-api-mode
58-container-xdg-persistence
56-container-side
46-agent-teams
```

The number goes first so `git branch -r` sorts and greps by issue, and so anyone
looking at a branch can find the *why* without reading the diff. The slug is a short
kebab-case hint, not a description — the issue holds the detail.

Rules:

- **One issue per branch.** If a fix spans two issues, either they're really one issue
  (merge them) or they're really two branches. Bundling means neither issue's history
  is reviewable on its own.
- **File the issue first.** A branch with no issue number has nowhere to record the
  problem statement, the options considered, or the verification — see
  [Filing an issue](#filing-an-issue) below.
- **Reference the issue in every commit** on the branch (`fix(#62): …`), so the fix is
  traceable from `git log` alone once the branch is gone.

Two pre-3.0 branches (`wrapper-typescript-rewrite`, `dridock-skill-statusline`) predate
this convention. Don't take them as precedent.

### Release branches — `release-X.Y.Z`

A standalone release commit — `VERSION` + `dridockVersion.ts` + `CHANGELOG.md` and
nothing else — goes on **`release-X.Y.Z`**, named for the version it cuts:

```
release-5.12.0
```

This is the one branch form that does **not** take an issue number, because a release
closes no issue. The "file the issue first" rule exists so a branch has somewhere to
record the problem statement and the verification; for a version bump the **CHANGELOG
entry is that record**, and it is in the commit itself.

- **Only for a cut that spans already-merged work.** A bump that belongs to one issue's
  work still rides in that issue's branch, which is how every release before 5.12.0
  happened — 5.10.0 came with #97 (`3567e8e`) and 5.11.0 with #89 (`7a0ea65`).
  Reach for `release-X.Y.Z` when the release covers issues that each shipped without a
  bump of their own — as #100/#101/#102 did, all being host-TS or hook-only.

  Those precedents are cited by **issue and commit, not branch name**, deliberately:
  work branches are deleted on merge, so a branch name is the one identifier that
  stops resolving the moment the work lands. Citing one as a precedent for others to
  follow sends them looking for something that no longer exists — and the first draft
  of this section got it wrong in exactly that way, naming a branch that had shipped a
  *different* release (`89-claude-cli-2-1-258` carried the 5.4.0 pin bump to 2.1.258;
  5.11.0's bump to 2.1.319 came from a separate #89 branch). The issue number and the
  commit sha both survive.
- **Whoever cuts it owns it**: ff-merge to `master`, tag the merged commit, delete the
  branch. Same ownership rule as any other branch.
- **Don't use `DRIDOCK_ALLOW_MASTER_COMMIT=1` instead.** The override exists, but the
  guard it defeats is there precisely because discipline failed once already; spending
  it on a routine release is how it stops meaning anything. A release branch costs one
  extra command.

Why this needed writing down (#103): the pre-commit hook refused the 5.12.0 bump and
pointed at `<issue#>-<slug>`, a form that cannot apply to a release. The guard was
right and its advice was impossible — so the next person's options were an override
they shouldn't reach for or a name they'd invent.

Merging is **fast-forward** where possible (`git merge --ff-only`); check with
`git merge-base --is-ancestor origin/master <branch>` before assuming it isn't.
Note that landing anything on `master` while a long-lived branch is open puts that
branch out of FF range, so prefer to hold unrelated commits until it merges.

### Installing the guard — `make hooks`

The pre-commit guard lives in `.githooks/`, which git does not read. It has to be
copied into `.git/hooks/`, and that is what **`make hooks`** does — once per clone:

```bash
make hooks          # install / refresh every hook in .githooks/
make hooks-check    # report missing, stale, or shadowed hooks; silent when clean
```

Since #104 you get it for free: `./install.sh` runs the installer before the image
build, and a SessionStart hook nags when this clone's copies are missing or stale.
Three layers because one wasn't enough — on 2026-11-09, two months after this file
started requiring the step, a second checkout of this repo on the same host
(`~aberezin/.../docker-out-of-docker/docker-claudebox`) still held only
`.git/hooks/*.sample`. The guard was documented as enforced and was absent from a
live checkout. Name the path, not the owner: the first draft of these comments
attributed that checkout to Bear, and Bear disproved it — its workspace is a
*different* directory (`docker-claudebox-in-claudebox`) and `docker-claudebox` is
not mounted into its container at all.

**Staleness is the quieter half.** `.githooks/pre-commit` has changed twice (5.4.0
reworded its refusal, #103 added the release-branch advice). A clone that installed
the old copy has a guard that is present, executable, passing, and handing out advice
this repo has retracted. `make hooks-check` is what notices.

**The guard also refuses a lost exec bit (#116), on every branch.** A commit that
takes a tracked file from `100755` to `100644` is refused with the file named and a
`chmod +x … && git add …` line to fix it. Override for a deliberate removal:
`DRIDOCK_ALLOW_MODE_CHANGE=1 git commit …` (it doesn't bypass the master check).
Finishing a conflicted merge by hand only warns: the removal came from the merged
branch, and `chmod +x` there would undo it. A brand-new script has no mode change to
catch, so the guidance says to `chmod +x` after any `sed -i` and check `git ls-files -s`. The
usual cause is GNU `sed -i` on the virtiofs workspace mount: it renames a temp file
over the original and the mode doesn't survive, so a 755 script comes out 600 and git
stages it as 644. `entrypoint.sh` lost its bit that way on #105 and #107, and review
caught it both times. The baked framework guidance tells every claudebot the same
thing, since the mount behaves this way in any dridock project.

**Why not `core.hooksPath=.githooks`?** It looks like it deletes this whole problem.
Two reasons it doesn't:

- **Scope.** `git config core.hooksPath .githooks` writes to `.git/config` and applies
  to **that repo only** — it is not global unless you pass `--global`, and you should
  not: a relative `hooksPath` is resolved per-repo, so a global setting silently points
  *every* repo you own at its own non-existent `.githooks/` and disables `.git/hooks/`
  everywhere, including hooks other tools installed for you.
- **It is worktree-relative, and it replaces rather than supplements.** `.githooks/`
  only exists on branches that have it (it arrived in `437dc1c`), and `core.hooksPath`
  does not fall back to `.git/hooks/` — so on a branch that predates the file there is
  no guard at all. Tested exactly that way and the guard silently did nothing, which is
  worse than no guard because you believe you are covered. `.git/hooks/` lives outside
  the worktree and is therefore branch-independent.

Because a set `hooksPath` makes an install a no-op with no other symptom, the installer
refuses rather than reporting success, and names the scope that set it.

**Unless the hooksPath chains back (#117).** A `hooksPath` directory can hold a
dispatcher that runs its own hooks and then the repo's
`$(git rev-parse --git-common-dir)/hooks/<name>`. That's what #113 installed as Alan's
global `hooksPath`, and there the guard does run. So the installer looks at the file git
will actually run, `<hooksPath>/<name>` for each hook this repo ships (following
symlinks). If it's executable and its code (comments stripped) calls `rev-parse` and
refers to the repo's hooks dir, that hook counts as chained. `--git-common-dir` always
qualifies. `--git-dir` and `.git/hooks` qualify only outside a linked worktree: inside
one they lead to `.git/worktrees/<name>/` or a `.git` file, where no hooks live. A
chained hook means `--check` stays silent, and
an install prints one line saying chaining was detected plus the probe that proves it
(commit on master and watch the guard refuse). It's a heuristic on the file's contents,
not a run of the chain, which is why the message offers the probe rather than claiming
it works. Any shipped hook without such a file still gets the full warning. A
`hooksPath` pointing at the repo's own `.git/hooks` shadows nothing and is accepted.

Adding a **new** hook is one step: drop it in `.githooks/` under its real git hook name
(no `.sh` extension — git never calls `pre-push.sh`). The installer walks the directory,
so nothing else needs editing; it refuses a name git wouldn't recognise instead of
copying it somewhere git never looks. Covered by `tests/test_githooks_install.sh`.

### Who merges

**Whoever owns the branch merges it, and says so on the issue** — a close-note naming
the merge commit (and tag, if one was cut). The reviewer signs off; they do not merge.

"Signed off" does not say who merges, and that ambiguity has two failure modes, both
seen on #62/#64: each agent waits for the other, or both merge and one clobbers.
Ownership decides *who*; it does not decide *whether it has been verified* — a branch
still needs its sign-off before its owner merges it.

### The install gate — Alan runs `./install.sh` from his Mac shell

**A branch that touches the build path is not DONE — issue closed, branch deleted —
until Alan has run `./install.sh` on that code, from his shell on the Mac, and it has
ended in `✅ setup complete`.** Running it before the merge is the preferred order and
the one to ask for; merging first is allowed on the terms below, which is why the rule
is written against "done" rather than "merged". The build path is
any of: `install.sh`, `Makefile`, `Dockerfile`, `.dockerignore`, and dridock-ts's build
(`dridock-ts/package.json`, `bunfig.toml`, the lockfile). The reviewer's sign-off is
still required, but for these branches it isn't enough on its own.

**The runtime is part of the gate, and it is decided by the SHELL, not the directory.**
`DRIDOCK_BACKEND` auto-selects `docker` inside a container (`Makefile:24`), so the same
checkout gives macOS + colima from Alan's Mac shell and Linux + the ambient daemon from a
container shell — and only the first can hit the macOS-only xattr failure this gate exists
for (#114). A claudebot's container mounts Alan's checkout at its own host path, so the
path alone does not tell you which ran. The merge note therefore quotes **the shell and
the checkout path**, not only the final line: "Alan's bash (aberezin), in
`/Users/aberezin/…/<checkout>`" is the claim that can be checked; "Alan ran it" is not.

How it runs — the preferred order:

1. The owner pushes the branch, gets the sign-off, then asks Alan in a WHERE/TYPE block:
   `git fetch && git checkout <branch> && ./install.sh`.
2. Alan pastes the output. The owner checks that it ended in `✅ setup complete` and
   quotes that line, the checkout path, and what it built (since #111 an install builds
   both variants), in the merge note.
3. The owner fast-forwards master. Because the merge is a fast-forward, the binary
   Alan just installed is exactly what master becomes. If the branch is abandoned
   instead, `git checkout master && ./install.sh` puts master's binary back.

**If it merged first.** Not a precedent-driven rule — on the record the gate has held
whenever it applied (see the precedents below) — but a fallback written before it is
needed. The gate costs a two-variant image build plus a round trip through Alan, so there
will be a moment when merging first looks right, and an unwritten fallback gets improvised
in exactly that moment. The terms:

- The run happens on **master, immediately**, with no other work merged in between. One
  commit under test, not a pile.
- The **branch is kept** until the run comes back green. Deleting it first is what makes
  the next step impossible.
- A failure is a **revert of the merge**, not a fix-forward. Fixing forward on master
  means the tree nobody has installed successfully is the tree everyone now pulls.

The ordering is safe to vary *because* the merge is a fast-forward: master and the branch
tip are the same commit, so the run is equally valid on either side of it. What changes
is the blast radius and who is holding it — which is why the terms above are about
containing a failure, not about the run itself.

**`✅ setup complete` and "the change is live" are two facts, not one.** The install
builds into cb-infra and installs the host binary. It does **not** put a baked change
inside a running container: a project VM holds its own copy of the image, and #115's
shim fix passed the gate while `dridock down && dridock start` still recreated the
container from the old image — `dridock --version` kept exiting 2, with no warning
(#118). So for a branch whose change is **baked into the image** — `entrypoint.sh`, the
`cb-*` helpers, the in-container `dridock` shim, `profiles/*`, the `Dockerfile` itself —
the gate also needs one check from inside a container after a restart, and the merge note
quotes that too. Since #118 (`37e1a1c`), `dridock start` reseeds the project VM whenever
cb-infra holds a different build, so a plain `dridock down && dridock start` is enough —
that logic lives in the host binary, so it applies once the installed `dridock` includes
`37e1a1c`, which a gate run on any branch based on it installs before the restart;
`DRIDOCK_FORCE_RESEED=1` remains the way to force the copy when the drift question comes
back `image drift not checked`, which is what an unreadable image identity reports.

Why only Alan's run counts: the build reads **Alan's** working tree, including files
git doesn't track and no diff shows. In #114, a mode-000 `.bun-build` file that the
container's `bun build --compile` left in `dridock-ts/` was gitignored, so `git status`
stayed clean through four merges. It failed `./install.sh` only on macOS, where
listing a file's xattrs needs read permission (Linux doesn't), and only from Alan's
tree. Arfy's clone had no stray, and the container's builds don't hit the macOS
failure. #110–#112 each merged with "real `./install.sh` not verified" written in the
merge note. That line was a disclosure; this gate makes it a step.

The incident's general lesson, which this gate exists to enforce: three real checks in
a row each lacked the one property that caused the break. A `.dockerignore` pattern
was read by eye instead of being run through docker. Its test used readable files when
the real ones were mode 000. A container probe ran on the container's own filesystem
instead of the mount. **When you reproduce a failure, reproduce the property that
caused it, in the environment where it happened.**

A branch outside the build path can still break the install by leaving state behind,
as #110 did, without touching any of these files. `install.sh` now clears or names
unreadable files before it builds (`install_clear_unreadable`), and agents don't run
builds with their working directory inside the shared checkout.

**The record**, cited by issue and commit because branch names stop resolving once the
branches are deleted (#103). **#114** `cd57925`: the gate's first use, and it held — Alan's
run was on the branch tip and the merge followed it. **#117** `e21d369`: never gated, since
it touched `.githooks/install.sh` and not the build path above; Alan's run there was a
confirmation the owner asked for. **#115** `e0a679e`: the one real miss, and not of the
run — the run happened and passed. What failed was the inference: `✅ setup complete` was
read as "the fix is live", and the project VM kept the old image (#118), so
`dridock --version` still exited 2 in the recreated container. That is the hole the
two-facts paragraph above closes (#119).

One scope question this leaves open for Alan: root `install.sh` *runs*
`.githooks/install.sh`, so a change there changes what an install does without touching
anything in the build-path list. Widening the list to "anything `install.sh` runs" would
cover it; that is a decision, not a precedent, and it is not made here.

### Claiming something is verified

**Name the environment, or you haven't verified it.** "Verified on real runs" is a
weaker claim than it sounds when this project ships into two runtimes — macOS/colima
on the host and Linux/`docker` in the container — and most bugs live in exactly one.

Say *macOS + colima* or *Linux + docker backend*, and say which you did **not** cover.
Two separate bugs in one day were invisible to one side and obvious from the other:

- **#63** — the runner counted visibly-failing tests as PASSED. Only reachable on the
  `docker` backend, because the test that exposed it legitimately passes under colima.
- **#66** — elapsed time vanished entirely because Linux `procps-ng` left-pads
  `ps -o etime=` and BSD `ps` does not. Verified working on macOS; shipped broken for
  the container, which is the primary target.

Neither was found by review. Both were found by the *other* runtime running the same
code. When you cannot exercise a path, say so and hand it to whoever can — that is a
result, not an admission.

## Changelog policy

Every version bump gets a `CHANGELOG.md` entry. Detailed fork changes **between the
upstream fork point and 2.0.0 were not recorded** in the changelog (they live in the
git history / are summarized in the README's "What's different in this fork"); the
changelog is **authoritative from 2.0.0 onward**.

## Backlog / issue tracking

Work not yet shipped lives in **GitHub Issues on the fork**:
[github.com/aberezin/docker-claudebox/issues](https://github.com/aberezin/docker-claudebox/issues).
That's the single source of truth for open work — the running list of proposals,
open design decisions, and residual TODOs. If it's not filed there, it isn't tracked.

### Standard labels

| Label | Meaning |
|---|---|
| `3.0-bundle` | Queued for the `2.x → 3.0` breaking migration (dridock rename, host↔container command unification, plugin system, etc.). Don't ship in isolation. |
| `framework-dev` | Ergonomics for developing the harness itself (from inside a claudebot or on the Mac). |
| `browser-bridge` | CDP bridge, Chrome control, browser testing. |
| `backlog` | Filed from `.dridock/BRIEF.md`'s handoff log during a working session (as opposed to a fresh user-reported issue). |
| `enhancement` / `bug` / `documentation` | Standard GitHub defaults. Use them. |

Custom labels are managed with `gh label create --repo aberezin/docker-claudebox …`.
Enable Issues on a new fork with `gh repo edit --enable-issues` (once per repo — the
fork inherits upstream's "issues disabled" default).

### Filing an issue

Use `gh issue create` (from anywhere with a working `GH_TOKEN` — the Mac, or a
framework-dev claudebot with fresh secrets), and follow the template shape:

```
## Problem            — what's the concrete symptom / gap
## Options            — the two or three shapes worth considering, with tradeoffs
## Sizing / timing    — small / medium / big; urgent or queue for a bundle
## Related            — links to prior commits, CHANGELOG entries, sibling issues
```

A backlog item is complete when a reader can act on it without asking a follow-up
question. Copy-pasting a paragraph from `BRIEF.md` is fine — that log's TODO entries
are already written in this shape.

### Closing an issue

Link the commit that ships the work with `Fixes #N` in the commit body (or as a PR
title if you're going through a PR). GitHub auto-closes the issue when the commit
lands on `master`. Reference the same issue number in the `CHANGELOG.md` entry so the
audit trail is bidirectional.

### Relationship to `.dridock/BRIEF.md`

The BRIEF's Progress/handoff log stays the **narrative** — what happened this session,
what's next, what's undecided *right now*. When a decision solidifies into "we should
do this eventually," file it as an issue and cross-reference from the log entry. The
log is a scratchpad; the issue tracker is the ledger.

## See also

- `CHANGELOG.md` — the running record of version bumps.
- [github.com/aberezin/docker-claudebox/issues](https://github.com/aberezin/docker-claudebox/issues) — the backlog.
- [Per-project VM lifecycle](design/per-project-vm.md) — where `version` /
  `checkversion` sit among the VM commands.
- [bootstrap.md](design/bootstrap.md) — where `.dridock/BRIEF.md` fits in the
  project lifecycle (the log side of the backlog / log split).
- The top-level `CLAUDE.md` "Conventions worth knowing" — the one-line rule.

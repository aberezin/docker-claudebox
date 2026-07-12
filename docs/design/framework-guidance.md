# How framework guidance reaches the claudebot

Every claudebot needs to know the conventions of the environment it runs in — orchestration,
the N-tier networking standard, disk discipline, secrets rules, the `cb-*` tooling, the
consult/bug channels. This doc is how that guidance is delivered, and why it lives where it
does.

## The mechanism: `~/.claude/CLAUDE.md` (user memory), rewritten every start

The entrypoint writes the framework guidance to **`/home/claude/.claude/CLAUDE.md`** — Claude
Code's **user-memory** file — and **overwrites it on every container start** from the baked
image.

Claude Code loads memory files additively, in this precedence (broad → specific):

1. managed/enterprise policy
2. **user memory — `~/.claude/CLAUDE.md`** ← framework guidance lives here
3. project memory — the workspace `./CLAUDE.md` (and parent dirs)
4. local — `./CLAUDE.local.md`

All discovered files are **concatenated into context**, not overridden. So the framework
guidance (user memory) and the project's own `./CLAUDE.md` are **both** loaded, every session —
including non-interactive (`-p`) and `--dangerously-skip-permissions` runs, which is how the
claudebot runs. Verify what loaded in a session with the **`/memory`** command.

## Why this design

It fixes two failure modes of the previous approach (copying a template into the workspace
`./CLAUDE.md` once, only if none existed):

| Problem (old) | Fixed by user memory |
|---|---|
| **Existing-repo projects got nothing.** A project that already had its own `./CLAUDE.md` skipped the template copy entirely, so it never received the framework guidance. | User memory is loaded *regardless* of whether the project has a `./CLAUDE.md`. |
| **Guidance went stale.** The workspace copy was made once and never refreshed, so harness updates never reached existing projects (the "task #10" propagation gap). | Rewritten from the image on *every* start, so a reseed to a newer image always carries current guidance. |
| **It mixed with project content.** Once copied, framework text and the project's own notes lived in one file. | The framework file is separate and framework-owned; the project's `./CLAUDE.md` is never touched. |

This is the same "shipped content, rewritten every start" pattern as the container `/claudebox`
skill — a file the framework owns, so overwriting it each boot is safe.

## What each kind of project gets

- **Framework guidance** → `~/.claude/CLAUDE.md`, always, always current.
- **A greenfield project** (no `./CLAUDE.md`): the harness creates **no** workspace `CLAUDE.md`.
  The project makes its own (via `/init`, or as the claudebot develops conventions) when it has
  something project-specific to say. The framework guidance is already covered by user memory.
- **An existing-repo project** (has its own `./CLAUDE.md`): untouched — it keeps its file *and*
  now also gets the framework guidance via user memory.
- **A bootstrapped project** (`.claudebox/BRIEF.md` present): the "read your BRIEF.md first"
  mission banner is emitted **into the user-memory file** (conditionally), where it's always
  loaded — it is no longer prepended to the workspace `CLAUDE.md`.

## Precedence & non-overlap

User memory loads *before* the project `./CLAUDE.md`; if the two ever gave **conflicting**
instructions, resolution is unspecified. Keep them in their lanes: the framework file is about
the *environment* (how to orchestrate, network, manage disk, use `cb-*`, escalate) and the
project file is about the *project* (its architecture, commands, conventions). They shouldn't
overlap, so precedence rarely matters.

## Migration notes

- **Old greenfield projects** that already baked the guidance into their workspace `./CLAUDE.md`
  will now carry a (stale) duplicate alongside the fresh user-memory copy. This is harmless —
  the user-memory version is authoritative and current. We do **not** auto-strip the workspace
  copy (it's mixed with project edits). Delete the framework section by hand if you like.
- Existing projects pick up the new mechanism on their next reseed to an image that has it.

## Size

There is no hard size limit on `CLAUDE.md`, but Claude Code's guidance is to keep each file
under ~200 lines — longer files consume more context and reduce adherence. The generated file is
currently a bit over that (it includes the full tool inventory); trimming it toward the
directive essentials (and letting `cb-help` / discovery cover the rest) is a worthwhile
follow-up.

## See also

- [convenience-scripts.md](convenience-scripts.md) — the `cb-*` tooling the guidance points at, and the "rewritten every start" `/claudebox` skill pattern this mirrors.
- [bootstrap.md](bootstrap.md) — `.claudebox/BRIEF.md` and the mission banner now surfaced via user memory.
- [n-tier-networking.md](n-tier-networking.md) · [disk-management.md](disk-management.md) — standards summarized in the baked guidance.
- [../../CLAUDE.md](../../CLAUDE.md) — the repo convention that `~/.claude` is bind-mounted, so framework `.claude` content must be seeded at runtime (this is that pattern).

---
name: framework-consult
description: Work a claudebot's framework consult — draft a reply + proposed harness change with an Agent sub-agent, gated by the human's approval, then apply it and reply. Use when the human says "work consult <id>", or a `claudebox` run reports consults awaiting a framework draft.
---

# framework-consult — the framework-Claude side of a consult

A **consult** is a supervised thread from a claudebot (building an app in a container)
asking framework-Claude (you, in *this* harness repo) to resolve a **general
claudebox best-practice** problem. Full design: `docs/design/framework-consult.md`.
You are a **peer** of the claudebot, not its parent; the only sub-agent you spawn here is
the **drafting sub-agent** below. The human is the approval gate — nothing you draft
reaches the claudebot until they run `claudebox consult approve`.

## 0. Find the work

```bash
claudebox consult list                 # all threads + status
claudebox consult show <id>            # full thread + any proposed.diff
claudebox consult watch                # block until a thread changes, then exit (see below)
```
- `awaiting-framework` → it needs your draft (step 1).
- `awaiting-claudebot` → the human approved; **apply + reply** (step 3).
- `awaiting-approval` → waiting on the human; do nothing but tell them.

**To stay alerted without babysitting**, run `claudebox consult watch` as a **background
task** (`run_in_background: true`). It's token-free and blocks until any thread changes,
then exits and prints what changed — the harness re-invokes you on exit. Handle the
change (usually: draft an `awaiting-framework` thread), then **relaunch the watcher** —
that relaunch is the loop; without it you only catch one change. A **SessionStart hook**
(`.claude/hooks/consult-session-start.sh`) surfaces pending consults and nudges you to
start the watcher at the beginning of each session in this repo, so you rarely have to
remember — but you still own launching and relaunching it.

## 1. Draft with an Agent-tool sub-agent (the "auto-draft")

Read the thread, then **spawn one `Agent` sub-agent** to produce the draft. Give it: the
full thread text, and the instruction to ground itself in THIS repo (wrapper.sh,
entrypoint.sh, the `cb-*` helpers, `docs/design/*`, the baked container `CLAUDE.md`
guidance). Require it to return, as structured text:
- **reply** — the answer to the claudebot, in claudebox terms.
- **generalizes** — one line on why this recurs across projects (if it does NOT, say so;
  the right move may be to tell the claudebot to solve it locally, not a framework change).
- **artifacts** — which durable harness change(s) capture the lesson: a `docs/design/*`
  standard, an edit to the baked `CLAUDE.md` guidance in `entrypoint.sh`, a new/changed
  `cb-*` helper, a wrapper/entrypoint fix, and/or a new env. **A consult with no durable
  artifact is incomplete** — the point is propagation, not a one-off answer.
- **proposed.diff** (optional) — a concrete patch if the change is small/clear.

Make the sub-agent **skeptical and specific**: is this really a framework concern or the
app's own responsibility? Does the proposed change interact with the rotating VM IP,
container-name-vs-IP duality, secrets rules, or the sidecar durability model?

Then write the draft to the thread and hand it to the human:

```bash
# body = the sub-agent's reply + its proposed artifacts/rationale
claudebox consult post <id> --author framework --status awaiting-approval --diff /path/to/proposed.diff < draft.md
```
(omit `--diff` if there's no patch yet). Tell the human: "consult `<id>` drafted —
review with `claudebox consult show <id>`, then `approve` / `revise` / `reject`."

## 2. Human gate (not yours)

The human runs `claudebox consult approve|revise|reject <id>`. `revise` bounces it back to
`awaiting-framework` with a note — re-draft addressing it. Do not proceed to apply until
the status is `awaiting-claudebot`.

## 3. Apply + reply (after approval)

When the human has approved (status `awaiting-claudebot`, and their approval turn is in the
thread): **apply the change in the harness for real** — edit the files, add/adjust a
`docs/design/*` standard, update the baked `CLAUDE.md` guidance and/or `cb-*` helper, run
`make build` if the entrypoint/image changed, bump the semver per
`docs/versioning.md` (new capability = MINOR; guidance-only doc = PATCH), add a CHANGELOG
entry, and commit. Then post the reply **with the commit hash** so the thread is auditable:

```bash
claudebox consult post <id> --author framework --status awaiting-claudebot <<EOF
Applied in <commit>. <one-paragraph summary of what changed and where the standard now lives>.
Adopt it and run \`cb-consult resolve <id>\`. Future claudebots inherit it via the baked guidance.
EOF
```

Leave the thread at `awaiting-claudebot`; the claudebot flips it to `resolved` once adopted.

## Notes

- Threads are addressed by **id** on disk and survive with no session open — you can pick
  up any thread later. Multiple claudebots → multiple threads; handle each independently.
- If a "consult" is really a defect, tell the human and point the claudebot at
  `cb-report-bug`; if it's app-specific, say so and close with `reject` (with a reason).
- The first standard this channel produced is `docs/design/n-tier-networking.md` — a good
  template for what a good resolution artifact looks like.

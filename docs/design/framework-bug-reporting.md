# Framework bug reporting

## The problem

A claudebot building a project may discover a bug in the **claudebox framework**
itself — the wrapper, the entrypoint, the image, or the Colima/Docker networking —
as opposed to a bug in the project it's building. It must not try to patch the
framework from inside a project (it can't, cleanly, and shouldn't), and a mention in
its final message is lost the moment the session ends. It needs a **standard,
persistent channel** that reaches the maintainer.

Motivating case: during the `examples/todo-app` demo, claudebot booted into an empty
workspace (the macOS `/tmp` → `/private/tmp` mount bug) and flagged it *in prose*.
That was only caught because a human was watching. A standard channel makes it a
durable, first-class signal.

A second, subtler failure mode: friction the agent can simply **work around** never
gets reported at all. In a later session a claudebot hit `EROFS` writing screenshots
to `cb-browser`'s read-only `/work` mount (the writable `/out` path was undocumented),
and instead of filing it, *degraded its own test* ("rewrite without screenshots") and
moved on. So the baked instruction tells claudebot to report a surprising or
under-documented baked helper **even when it found a workaround** — a silent
workaround is exactly how DX bugs stay invisible.

## Mechanism

1. **`cb-report-bug` (baked helper, container side).** Mirrors `cb-browser`:
   ```
   cb-report-bug "<title>" --layer wrapper|entrypoint|image|networking|other <<'EOF'
   ## What I was doing
   ## Expected vs actual
   ## Minimal repro
   ## Hypothesis
   EOF
   ```
   It wraps the body with metadata (layer, project id, timestamp, image variant) and
   writes one Markdown file per report. claudebot doesn't have to remember a path or
   format — just run the command.

2. **Shared host drop dir (deliberate shared-nothing exception).** The wrapper
   mounts `~/.config/claudebox/framework-bugs/` into **every** container at
   `/home/claude/framework-bugs` and passes `CLAUDEBOX_FRAMEWORK_BUGS_DIR` +
   `CLAUDEBOX_PROJECT_ID`. Reports from *any* project collect in one place. This is
   the one intentional break from the per-project shared-nothing model, because
   framework feedback is inherently cross-project. If the mount is somehow absent,
   `cb-report-bug` falls back to `./.claudebox/FRAMEWORK-BUGS.md` in the workspace.

3. **Host surfacing.** `claudebox framework-bugs` lists the reports (title + file);
   `claudebox framework-bugs clear` empties them. Any normal `claudebox` run prints
   `⚠ N framework bug report(s) on file` when the dir is non-empty, so they don't sit
   unnoticed.

4. **In-container surfacing (framework-dev, 2.16.0).** For a framework-dev claudebot —
   one whose workspace **is** a claudebox harness fork (`wrapper.sh` at root containing
   `CLAUDEBOX_VERSION=`; override with `CLAUDEBOX_FRAMEWORK_DEV=1`) — the host wrapper
   isn't reachable, so the same review flow lives in-container:
   - `cb-report-bug list` — every report in the drop dir (`✓` = reviewed).
   - `cb-report-bug show <slug>` — print a report.
   - `cb-report-bug done <slug>` — drop a `.reviewed` sidecar next to the report.
   The entrypoint scans the drop dir on every start and injects a startup note listing
   any reports without a `.reviewed` sidecar (plus any `awaiting-framework` consults),
   so a framework-dev session catches waiting work without a human telling it.

5. **Always-on guidance.** The baked `CLAUDE.md` notes and the always-appended
   system hint tell claudebot to use `cb-report-bug` for framework bugs (not project
   bugs) instead of working around them silently.
   The baked guidance's **framework-vs-project check** (does the rule name any
   project-owned code/schema/service? if no, it's framework) is what routes an agent
   to this channel in the first place — without it, framework friction gets written
   into project `CLAUDE.md` files and never reaches the drop dir at all.

## Not in scope (yet)

- Auto-filing GitHub issues (couples every container to `gh` auth + the repo).
- De-duplication across reports (the maintainer triages; volume is expected to be
  low).

## See also

- [convenience-scripts.md](convenience-scripts.md) — `cb-report-bug` and the `cb-*` convention.
- [browser-testing.md](browser-testing.md) — a common source of reportable tool friction.
- The top-level [`CLAUDE.md`](../../CLAUDE.md) — when to file vs. work around.

# Documenting dridock

How this fork's docs are organized, and the conventions to follow when you add or edit
one. Keeping to these is what keeps a topic-split doc set navigable.

## Where things go

| Location | What lives there |
|---|---|
| [README.md](README.md) (this dir) | The **landing index** — Reference / Modes / Design tables. Add a row when you add a doc. |
| `design/*.md` | Architecture, design rationale, and **standards** — one topic per file. |
| `modes/*.md` | One per run mode (interactive, programmatic, api, telegram, cron). Update when that mode's flags/behaviour change. |
| [environment-variables.md](environment-variables.md), [customization.md](customization.md), [versioning.md](versioning.md) | Reference material. |
| `../README.md` (repo root) | The top-level **Documentation** index + "What's Inside"; kept current per release. |
| `../CHANGELOG.md` | Per release (see [versioning.md](versioning.md)). |

## House style

- Open with a short line saying **what the doc is** — no throat-clearing.
- Be **concrete and specific to this framework**: real command names, real paths, real
  env vars — verify they exist in the repo, don't invent flags or helpers.
- Prefer **tables** for enumerations and **fenced code blocks** for commands/layouts.
- Match the tone of the sibling docs you're next to; no filler.
- **End every doc with a `## See also`** (man-page style) linking the sibling/related
  pages a reader would go to next. This is how a per-topic doc set stays navigable — it's
  a hard convention, not a nicety.

## Diagrams — we use Mermaid

Diagrams are written in **[Mermaid](https://mermaid.js.org/)** inside fenced
` ```mermaid ` blocks. Mermaid renders natively on GitHub and inside claude.ai artifacts,
and it stays **diffable text** — no binary images to maintain. Use it for sequence,
flow, and state diagrams (see [design/framework-consult.md](design/framework-consult.md)
for a sequence example).

**Syntax gotchas that have actually bitten us — check for these before shipping a diagram:**

- **No unescaped `;` in `Note` / node / edge label text.** Mermaid treats `;` as a
  **statement separator**, so everything after it is parsed as a new (invalid) statement
  and the diagram silently fails to render. Use a comma, an em-dash, or `<br/>` instead.
  (e.g. write `Note over A,B: peers — via the store, not directly`, **not**
  `… peers; via the store`.)
- Be wary of other structural characters in label text: unmatched `{ } ( ) [ ]`, a
  leading `#`, and raw quotes. When a label needs them, wrap the whole label in `"…"`.
- `<br/>` is the way to force a line break inside a label.
- **Sanity-check that it renders** (GitHub preview, or publish a quick artifact / send a
  `.mmd` for preview) before committing — a broken diagram fails quietly.

Keep the diagram as a fenced block **in the doc** (the doc is the source of truth); a
standalone `.mmd` is fine for sharing or previewing, but don't let the two drift.

## Updating docs when you change something

- New/changed **mode flag or behaviour** → the matching `modes/*.md`.
- New **env var** → [environment-variables.md](environment-variables.md).
- New **`cb-*` helper** → [design/convenience-scripts.md](design/convenience-scripts.md).
- New **design or standard** → a `design/*.md` **and** a row in [README.md](README.md).
- A **host↔image contract** change (sidecars, forwarded env, mounts) → bump `VERSION` +
  `CHANGELOG.md` per [versioning.md](versioning.md). A **pure docs change does not touch
  the contract** — don't bump `VERSION` for it (that would trigger spurious drift warnings
  and a needless reseed).

## See also

- [README.md](README.md) — the documentation landing index.
- [versioning.md](versioning.md) — when a change needs a `VERSION`/CHANGELOG bump.
- [design/convenience-scripts.md](design/convenience-scripts.md) — the sibling "how to add a `cb-*` command" convention.
- [design/framework-consult.md](design/framework-consult.md) — a worked Mermaid sequence diagram.

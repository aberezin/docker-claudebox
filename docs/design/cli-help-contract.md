# CLI help contract

How `--help` works across every `dridock` verb, and why this fork has no CLI
framework. Decided in [#60](https://github.com/aberezin/docker-claudebox/issues/60).

## The decision: no framework, one contract

Alan's question that opened #60 was *"something like that should generally be
provided by a cli command framework so I wonder if we are using a poor
framework."* Worth being precise: we were not fighting a bad library. There is
no library. Arg parsing is per-command hand-rolled loops over `args`.

We are **not** adopting one. The CLI has 27 command files behind an injectable
`Context` (fs/env/stdout/stderr/home/cwd) with ~1000 tests built on in-memory
fakes. A framework migration touches every command's parse path and every
test's construction, for the sole benefit of the help layer. High blast radius,
narrow payoff.

What a framework would have given us for free is one place where `--help` is
handled before per-command parsing. That is about fifteen lines, and we wrote
them.

## The contract

1. **`usage` is a required field on `Command`.** Not a convention — the
   interface. A verb physically cannot be registered without help text, so
   "new verb ships with no `--help`" is a compile error rather than something
   nobody notices. Before #60, 11 of 27 command files mentioned `--help` at all.

2. **The dispatcher answers `--help`**, in `CommandRegistry.dispatch`, before
   the command's own parser runs. One place, all registrations.

3. **First position only.** `start` forwards its args to `claude`, so
   intercepting a `--help` anywhere in the slice would swallow one meant for
   the inner process. As the first post-verb arg it is unambiguously addressed
   to dridock.

4. **Subverbs declare a table.** Verbs that dispatch on their own first
   argument expose `subverbs: [{name, synopsis}]`, so `<verb> <subverb> --help`
   and the unknown-subverb error render from the same source and cannot drift.

5. **A conformance test iterates the real registry** — `buildRegistry()`, the
   actual composition root, not a hand-maintained list that could drift from
   what ships. For every registered verb and every declared subverb it asserts
   `--help` exits 0, writes non-empty text naming that verb to **stdout**, and
   **touches no files**.

## Why the no-side-effects assertion is the important one

Missing help is an annoyance. What #60 actually found is worse:

```
$ dridock consult post --help
posted framework turn to --help          # rc=0
$ ls ~/.config/dridock/consult/
--help/                                  # a real thread, on disk
```

The subverb parser took the flag as its argument and **performed the
operation**. `consult show --help` looked up a consult with that id;
`consult watch --help` entered its watch loop. Removing the fix and re-running
the conformance test reproduces this: 10 failures, with `consult post` and
`consult watch` each taking 5000ms because they genuinely went and did the
thing.

That is the class this repo keeps hitting — a path that accepts input it does
not understand and proceeds anyway. Help is metadata about a command; asking
for it must never run the command.

## Adding a verb

Implement `Command`, give it a real `usage` (the conformance test rejects
placeholders and anything not mentioning `dridock`), declare `subverbs` if it
dispatches on its own first argument, and register it in `buildRegistry`. The
help behaviour then exists without further work, and is tested automatically.

## See also

- [../environment-variables.md](../environment-variables.md) — the env surface `--help` summarises.
- [ts-argv-diff-p4b.md](ts-argv-diff-p4b.md) — the bash→TS argv port this layer came from.
- [agent-teams.md](agent-teams.md) — `dridock team`, the verb with the most subverbs.

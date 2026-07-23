# TypeScript rewrite of `wrapper.sh` — status, scope, verification plan

The host-side wrapper (`wrapper.sh`, ~3300 lines of bash) is being ported to
TypeScript+Bun in [dridock-ts/](../../dridock-ts/), on branch
`wrapper-typescript-rewrite`. This doc is the map: what verbs the TS binary
handles, what still delegates to bash, and how Arfy verifies the port
on macOS before merge.

Related: [versioning.md](../versioning.md) (semver rules the port keeps),
[bootstrap.md](bootstrap.md) (project scaffolding), [per-project-vm.md](per-project-vm.md)
(VM lifecycle the port targets), [../../CLAUDE.md](../../CLAUDE.md)
(project conventions the port respects, including the audit rule).

## Why

`wrapper.sh` is battle-tested, but bash makes some things structurally hard:
- The 3.3.x audit found ~10 silent-drop-family bugs (#17, #30, #31, #32,
  #37). Every one was a case where a code path swallowed input, an error,
  or a flag with no visible signal. The TS port encodes the audit rule
  (visible warning + non-zero rc on any skip) **in the type system** —
  `MigrationOutcome.kind` is a discriminated union with no "quiet success"
  variant.
- Argument allowlists (`-p` mode: `--effort`, `--output-format`, …) were
  90-line `case` blocks. The TS `ProgArgValidator` is one pass with a
  closed `Set<string>` — same rejection semantics, half the LOC, and
  unit-tested against every branch.
- Unit-testing bash needs `mktemp -d` + `XDG_CONFIG_HOME=` scaffolding
  before every call. The TS port uses an `InMemoryFileSystem` fake —
  seed files/dirs directly in the test.

The goal is full cutover (bash wrapper eventually deleted), but the
strategy is **incremental**: the TS binary ships **side-by-side** with
the bash wrapper. Verbs cut over one at a time; bash remains the source
of truth for anything not yet ported.

## What's shipped (as of this doc)

Every verb below has:
- A `Command` class with `verb`, `run(args, ctx) → Promise<number>`
- A sibling `.test.ts` file (`bun test`; 370 unit tests total)
- Interfaces injected at the composition root — tests never touch a
  real disk / docker daemon / colima VM

| Verb | Status | Notes |
|---|---|---|
| `version` | ✅ Full | Matches `wrapper.sh` semver output. |
| `consult list` | ✅ Full | `consult show/approve/…` stub → rc 2. |
| `features list` | ✅ FS-only half | "Available" catalog still needs bash (Docker `cat` on image). |
| `features enable/disable` | ✅ Full | Via `writeTextAtomic` — atomic tempfile+rename, no half-written config.yml. |
| `features info` | 🟡 Stub | Needs `docker run --rm cat`; bash wrapper handles. |
| `checkversion` | ✅ Single-project | `--all` (sweep every cb-* VM) stubs → rc 2. |
| `info` / `status` | ✅ FS + Docker halves | VM/network/machine rows marked "Phase 3 stub — needs Colima adapter". |
| `migrate [--all]` | ✅ Full | 4 migrators + audit-rule discriminant. Every 3.3.x defect encoded (workspace split-brain, data-dir collision, live-Chrome guard, state-dir merge with `.legacy-<ts>` suffix). |
| `down` | ✅ Full | `colima stop --profile cb-<id>`. |
| `destroy` | ✅ VM half | `--purge` (data-dir rm -rf) stubs → rc 2. |
| `stop` | ✅ Full | Matches wrapper.sh:3025-3033. |
| `start` | 🟡 MVP | Interactive + `-p` paths work IF VM is up + image present. Cold-start (VM boot + image seed) still needs bash — rc 2 with clear "use bash wrapper" advice (audit rule: visible skip). |

### What still needs the bash wrapper

- **VM cold-start**: `colima start` with per-project cpu/mem/disk from
  `.dridock/config.yml`, network setup, reachable-IP polling.
- **Image build + reseed**: `make build`, `docker save | docker load`
  across contexts, drift detection.
- **Sidecar writers**: `~/.claude/.<container>-{auth,secrets,env,vmip}`
  the entrypoint re-reads on `docker start`.
- **Auto-continue with fresh-session fallback**: `--continue` first,
  detect its failure, fall back to a fresh session.
- **`DRIDOCK_ENV_*` passthrough**, `--update`, `bootstrap` in all its
  flag combinations, cron mode, api mode, telegram mode.
- **VM helpers**: `dridock vm ls|usage|gc`, `df`, `browser-bridge`,
  `host-agent`, `harness sync`, `report-bug`, `framework-bugs`,
  `net`/`ip`, `completion bash`, `setup-token`, `doctor`, `auth`, `mcp`.

## Install (opt-in)

The default `install.sh` still installs `wrapper.sh` as `dridock` — no
change. To also install the TS binary alongside:

```
DRIDOCK_INSTALL_TS=1 ./install.sh
```

This requires [bun](https://bun.sh) and installs the compiled binary as
`dridock-ts` in the same `INSTALL_DIR` (default `~/.local/bin`). The bash
wrapper remains the canonical `dridock` — the TS binary is opt-in for
verification.

## Why real-Mac verification matters (Arfy's rule)

The unit tests are necessary but **not sufficient** for anything that
touches the container-run path. `dridock-ts start` needed **six live
verification passes** on real macOS + real colima before it worked:

1. `-p` allowlist bypassed when VM was down (ordering bug)
2. `-p` used `-it` → fails headless in scripts/CI/pipes
3. `--network cb-net` (wrong network — sibling workloads only) → rc 125
4. Six argv-parity divergences from `wrapper.sh` `DOCKER_ARGS`
5. `-p` container name reused unconditionally → rc 125 on second run
6. `start` mounted the host global `~/.claude` (would leak the human's
   creds + break auth) — a security-adjacent bug the *structural* argv-diff
   missed because only the *resolved* source path differed

**Every one was green across all TS unit tests.** They live in the gap
between mocked interfaces (`InMemoryContainerRuntime`, `InMemoryColima`,
`InMemoryDocker`) and a live docker daemon + real auth + real filesystem
paths. That gap is exactly what Arfy's Mac-side pass is for.

Two habits emerged that dramatically cut the cycle:
- **Argv-diff before re-verify.** After Arfy caught two blockers in one
  round, we did a full bear-side token-diff of the derived `docker run`
  argv against `wrapper.sh`'s `DOCKER_ARGS` before asking her to
  re-bootstrap. That review turned up 6 changes at once instead of 6
  separate re-verifies.
- **Resolved-path sweep, not structural-diff.** The structural argv-diff
  sees `-v X:/home/claude/.claude` and confirms parity — but if `X`
  resolves to `${home}/.claude` vs `$CLAUDE_DIR`, only the resolved
  value diverges. A resolved-path sweep of every mount/env/sidecar in
  the run catches that class.

Bake both habits into any Phase-4b re-verify cycle. The unit tests are
excellent for correctness; they cannot substitute for a Mac-side pass
on anything that runs a container.

## Verification plan (Arfy)

Before we merge to master, we need the TS binary to prove out on real
macOS + real colima, not just on the unit tests. The bar is: for each
shipped verb (table above), the TS binary produces the same on-disk
outcome + user-facing text as the bash wrapper against the same project
state. Some verbs mutate state — those tests should compare against a
fresh checkout, not against a shared machine.

### Read-only verbs (no state change — safe to run repeatedly)

For each of `version`, `checkversion`, `features list`, `info` /
`status`, `consult list`, run both binaries against the same project
and diff the output:

```
diff <(dridock version) <(dridock-ts version)
diff <(dridock checkversion 2>&1) <(dridock-ts checkversion 2>&1)
diff <(dridock features list 2>&1) <(dridock-ts features list 2>&1)
diff <(dridock consult list 2>&1) <(dridock-ts consult list 2>&1)
```

Expected differences (documented, not bugs):
- `dridock-ts info` shows Phase-3 stub lines for VM/network/machine
  rows instead of the real values.
- `dridock-ts features list` shows a stub line for the "available"
  catalog.
- `dridock-ts checkversion --all` refuses with rc 2 and a stub message.

Anything else is a fidelity bug.

### Mutating verbs (need a fresh scratch project each time)

Create two identical scratch projects side-by-side, run one command
against each with the two binaries, compare final on-disk state.

```
cd /tmp
mkdir -p a b && cd a && dridock bootstrap && cd ../b && dridock bootstrap
# now edit both configs identically, then...
(cd a && dridock features enable typescript)
(cd b && dridock-ts features enable typescript)
diff a/.dridock/config.yml b/.dridock/config.yml   # expect: identical
```

Repeat for `features disable`, `migrate` (with a `.claudebox/`
scaffold), `down`, `destroy`.

### `migrate` in particular

The four migrators are where the audit rule pays off — they're also the
riskiest. Set up each failure mode explicitly in a scratch dir:

1. **Split-brain workspace**: `.claudebox/config.yml` AND
   `.dridock/config.yml` both present → expect skipped-conflict, rc 1,
   both files intact.
2. **Split-brain data dir**: `~/.config/claudebox/projects/<id>/` AND
   `~/.config/dridock/projects/<id>/` both present → skipped-conflict.
3. **Live-Chrome guard**: `~/.config/claudebox/cdp/chrome-debug-profile/`
   present, launch a Chrome pointing at it, run `dridock-ts migrate` →
   `cdp` should be skipped, `⚠ Chrome is running` on stderr, rc 1.
4. **State-dir merge**: seed some overlapping entries under
   `~/.config/{claudebox,dridock}/consult/` → expect clean entries move,
   colliding ones renamed `.legacy-<YYYYMMDDHHMMSS>`, rc 1 if any
   collided.

For each, verify the exit code (`echo $?`) matches the message on the
console. That agreement is exactly what the 3.3.1 → 3.3.2 followups
were fixing in bash; here it's a structural invariant.

### `start`

This is where the MVP boundary shows. Run against a project with the
VM already up + image already present:

```
dridock down          # start clean
dridock start         # bash: cold-starts the VM + attaches
# ... exit the interactive session ...
dridock-ts start      # TS: should attach to the same container
```

Expected: `dridock-ts start` reattaches the interactive container
successfully. If the VM is stopped, `dridock-ts start` should exit rc 2
with a clear "use bash wrapper" message (audit rule).

For `-p` mode, the safety test matters most:

```
dridock-ts start -p "hi" --effort hihg     # expect: ❌ Invalid effort
dridock-ts start -p "hi" --nonsense        # expect: ❌ Unknown flag
dridock-ts start -p "hi"                   # expect: runs, prints reply
```

## Merging

Once Arfy signs off on the fidelity of each shipped verb, we squash the
`wrapper-typescript-rewrite` branch into master as a single feat commit.
The bash wrapper stays as the default binary; TS remains opt-in via
`DRIDOCK_INSTALL_TS=1` until Phase 4b closes the remaining gaps and we
flip the default.

**Sign-off status (2026-07-23)**: Arfy signed off #38 on `af64a07` after
six Mac-side verification passes. See "Why real-Mac verification matters"
above for the pattern. Branch is ready to squash to master on Alan's
call; nothing else outstanding.

## See also

- [../../dridock-ts/](../../dridock-ts/) — the source
- [../versioning.md](../versioning.md) — the semver rules the port keeps
- [../../CLAUDE.md](../../CLAUDE.md) — project conventions the port respects

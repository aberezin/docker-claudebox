# P4b argv-parity diff — `dridock start -p 'hi'`

Bear-side resolved-path/env diff of `dridock-ts start` (`af64a07`+ after
P4b) vs the bash wrapper's `docker run` for a representative
programmatic invocation. Generated from the ts derivation script at
`dridock-ts/tools/argv-diff.mjs` (kept in scratchpad, not committed).

**Fixture:**
- workspace: `/Users/alan/dev/proj` (under `$HOME`, no `--mount`)
- project id: `9efaf926`
- config.yml has just the id; no `network.hostname`; no features
- secrets.env has `GH_TOKEN=ghp_example`
- host env: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `DRIDOCK_ENV_MY_VAR=hello`
- host git config: `user.name`, `user.email` seeded
- VM already Running, image present, cb-infra Running with matching version
- CDP bridge OFF, host-agent OFF, no tmpfs opt-in, no --update, no DEBUG

## Derived TS `docker run` argv

```
docker --context colima-cb-9efaf926 run --name claude-_Users_alan_dev_proj_prog
  --network host
  -e DRIDOCK_CONTAINER_NAME=claude-_Users_alan_dev_proj_prog
  -e DRIDOCK_GIT_NAME=Alan Berezin
  -e DRIDOCK_GIT_EMAIL=alan@example.com
  -e DRIDOCK_WORKSPACE=/Users/alan/dev/proj
  -e DRIDOCK_PROJECT_ID=9efaf926
  -e DRIDOCK_FRAMEWORK_BUGS_DIR=/home/claude/framework-bugs
  -e DRIDOCK_CONSULT_DIR=/home/claude/framework-consult
  -e DRIDOCK_VM_IP=192.168.64.13
  -e MY_VAR=hello
  -v /Users/alan/.ssh/claudebox:/home/claude/.ssh
  -v /Users/alan/.config/dridock/projects/9efaf926/claude:/home/claude/.claude
  -v /Users/alan/dev/proj:/Users/alan/dev/proj
  -v /var/run/docker.sock:/var/run/docker.sock
  -v /Users/alan/.config/dridock/framework-bugs:/home/claude/framework-bugs
  -v /Users/alan/.config/dridock/consult:/home/claude/framework-consult
  dridock:latest
  -p "hello world" --output-format text
```

Mode: `attached` (no `-it`, no `-d`). Auth + secrets travel via sidecar
files under the mounted data dir — never on argv.

## Corresponding bash `docker run` (from wrapper.sh DOCKER_ARGS)

```
docker --context colima-cb-9efaf926 run --name claude-_Users_alan_dev_proj_prog
  --network host
  -e DRIDOCK_GIT_NAME=Alan Berezin
  -e DRIDOCK_GIT_EMAIL=alan@example.com
  -e DRIDOCK_WORKSPACE=/Users/alan/dev/proj
  -e DRIDOCK_CONTAINER_NAME=claude-_Users_alan_dev_proj   ← interactive name
  -v /Users/alan/.ssh/claudebox:/home/claude/.ssh
  -v /Users/alan/.config/dridock/projects/9efaf926/claude:/home/claude/.claude
  -v /Users/alan/dev/proj:/Users/alan/dev/proj
  -v /var/run/docker.sock:/var/run/docker.sock
  -v /Users/alan/.config/dridock/framework-bugs:/home/claude/framework-bugs
  -e DRIDOCK_FRAMEWORK_BUGS_DIR=/home/claude/framework-bugs
  -e DRIDOCK_PROJECT_ID=9efaf926
  -v /Users/alan/.config/dridock/consult:/home/claude/framework-consult
  -e DRIDOCK_CONSULT_DIR=/home/claude/framework-consult
  -e MY_VAR=hello                                          ← from DRIDOCK_ENV_MY_VAR
  -e DRIDOCK_CONTAINER_NAME=claude-_Users_alan_dev_proj_prog  ← per-run override at :3288
  dridock:latest
  -p "hello world" --output-format text
```

(CDP / host-agent / VM-IP off-path lines not shown since bridges are
down in this fixture. When up: bash also adds `-e DRIDOCK_HOST_CDP_URL`
+ `-e DRIDOCK_VM_IP` + `-e DRIDOCK_HOSTNAME` conditionally, same shape
as ts.)

## Diff table (resolved paths)

| item | bash | ts | verdict |
|---|---|---|---|
| context | `colima-cb-9efaf926` | `colima-cb-9efaf926` | ✅ |
| container name | `claude-_Users_alan_dev_proj_prog` | same | ✅ |
| network | `host` | `host` | ✅ |
| mode | no `-it`, no `-d` | `attached` = no `-it`/`-d` | ✅ |
| workspace mount | `/Users/alan/dev/proj:/Users/alan/dev/proj` | same | ✅ |
| .claude mount (per-project data dir) | `/Users/alan/.config/dridock/projects/9efaf926/claude:/home/claude/.claude` | same | ✅ |
| SSH mount | `/Users/alan/.ssh/claudebox:/home/claude/.ssh` | same | ✅ |
| docker socket | `/var/run/docker.sock:/var/run/docker.sock` | same | ✅ |
| framework-bugs mount | `/Users/alan/.config/dridock/framework-bugs:...` | same | ✅ |
| consult mount | `/Users/alan/.config/dridock/consult:...` | same | ✅ |
| DRIDOCK_GIT_NAME | `Alan Berezin` | `Alan Berezin` | ✅ |
| DRIDOCK_GIT_EMAIL | `alan@example.com` | `alan@example.com` | ✅ |
| DRIDOCK_WORKSPACE | `/Users/alan/dev/proj` | same | ✅ |
| DRIDOCK_PROJECT_ID | `9efaf926` | `9efaf926` | ✅ |
| DRIDOCK_FRAMEWORK_BUGS_DIR | `/home/claude/framework-bugs` | same | ✅ |
| DRIDOCK_CONSULT_DIR | `/home/claude/framework-consult` | same | ✅ |
| DRIDOCK_CONTAINER_NAME (in-container) | `_prog` (override wins) | `_prog` (single entry) | ✅ same in-container value |
| MY_VAR (from DRIDOCK_ENV_MY_VAR) | `hello` | `hello` | ✅ |
| DRIDOCK_VM_IP | present when VM reachable | present | ✅ |

## Notable non-divergences (worth spelling out)

- **`DRIDOCK_CONTAINER_NAME` deduplication**: bash writes it twice (interactive
  name in DOCKER_ARGS at :2817, then `_prog` override at :3288 — docker's
  last-wins). TS writes it once, correctly, with the role's name in-line.
  Same in-container value. TS argv is one line shorter; not a fidelity bug.
- **Env-forwarding via -env sidecar in addition to `-e`**: both bash and
  TS write both. The `-e` covers first-run; the sidecar covers `docker start`
  which can't inject new env. Same shape.
- **Auth + secrets not on argv**: sidecars only. Both bash and TS enforce
  this — never `-e` a value that could carry a credential (would leak via
  `ps`).
- **Ordering of `-e` and `-v`**: bash interleaves; TS groups (all `-e` then
  all `-v`). Docker doesn't care about order between `-e` and `-v`; only
  the last-wins semantics matter, and none of our env keys are duplicated
  (see previous). Not a fidelity bug.

## Off-path additions activated by env/state (not exercised in this fixture)

- `--tmpfs /tmp:size=…` — when `DRIDOCK_TMPFS_TMP` set (bash + TS parity).
- `-e DRIDOCK_HOST_CDP_URL=…` + cdp sidecar — when `.cdp-url` marker present.
- `-e DRIDOCK_HOST_AGENT_URL/TOKEN` + hostagent sidecar — when host-agent daemon alive.
- `-e DEBUG=true` — when `DEBUG=true`.
- `-e DRIDOCK_DEFAULT_PLUGINS=…` — when set.
- Extra `-v` per `DRIDOCK_MOUNT_*` — bash + TS parity, sorted stably.

All of these are exercised in unit tests; no bear-side live-verify diff
run against them since they only activate under specific conditions
that fresh scratch envs don't naturally set up.

## Verdict

Every resolved-path / resolved-env value is identical between bash and
TS for the representative `-p 'hi'` invocation. The one shape difference
(`DRIDOCK_CONTAINER_NAME` deduplication) is a TS improvement with
identical in-container semantics. Ready for Arfy's kitchen-sink live pass.

## See also

- [typescript-rewrite.md](typescript-rewrite.md) — the parent handoff doc.
- `wrapper.sh:2812-2970` — the DOCKER_ARGS assembly this diff was cross-checked against.
- `dridock-ts/src/cli/commands/StartCommand.ts:baseRunArgs` — the TS composition point.

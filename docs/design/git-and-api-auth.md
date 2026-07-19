# Git-vs-API auth (SSH for git, per-provider tokens for API)

**Status:** design (2026-07-19, 3.0-bundle). Shipped by issue [#10](https://github.com/aberezin/docker-claudebox/issues/10).

## Summary

Two roles, two mechanisms, kept apart:

1. **Git operations** (clone / fetch / pull / push): **SSH only**, via the container's
   `~/.ssh/claudebox/id_ed25519` key. One keypair, added to each git host you use.
   Works uniformly across GitHub, GitLab, Bitbucket, Gitea, self-hosted, air-gapped —
   any provider that speaks SSH-git. The harness does **not** install a git credential
   helper; git-over-HTTPS falls through to SSH.
2. **API operations** (`gh issue`, `glab mr`, `gh api`, any provider REST/GraphQL):
   **per-provider tokens** in `.dridock/secrets.env`
   (`GH_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `GITEA_TOKEN`, …). Each provider CLI
   picks up its own env var; the harness stays provider-agnostic.

## Why the split

The 2.x behavior — a single `GH_TOKEN` in `.claudebox/secrets.env` + the entrypoint
running `gh auth setup-git` on every start so `git push https://…` "just works" — has
four failure modes:

- **Snapshot staleness.** `secrets.env` is read on `docker run`/`docker start`;
  mid-session rotation on the Mac never reaches a running container. The user
  regenerates a token, updates the file, keeps hitting stale-auth errors.
- **Credential-helper hijack.** `gh auth setup-git` installs `git-credential-gh`,
  which reads `gh`'s stored auth (`~/.config/gh/hosts.yml`) — not the env `GH_TOKEN`
  the wrapper injected. When those diverge (host `gh` logged in as user-A, container
  env `GH_TOKEN` is user-B), `git push` uses A while `gh api` uses B — silently. Full
  debugging session on 2026-07-17, commit `1d6e79e`.
- **Multiple competing paths, different refresh semantics.** Env `GH_TOKEN`, `gh`'s
  stored token, the credential helper, embedded `user:token@host/...` URL creds all
  work at different points; a rotation touches some but not others.
- **GitHub-only.** `gh` is a GitHub CLI. `glab` (GitLab), Bitbucket (no first-party
  CLI), self-hosted forges each need their own tool. Baking `gh auth setup-git` into
  the boot path locks the harness to one provider.

Splitting removes the credential helper from the picture entirely, and each provider
gets one obvious place for its API token.

## What the wrapper does

`dridock bootstrap --seed-secret KEY=CMD` (repeatable) runs `CMD` on the host, writes
its stdout into `.dridock/secrets.env` as `KEY=<value>`:

```bash
dridock bootstrap --seed-secret GH_TOKEN='gh auth token' \
                  --seed-secret GITLAB_TOKEN='glab auth token' \
                  "build project-A"
```

The value never touches the command line — only the *command that fetches it* does.
`--gh-token` is kept as a deprecated alias for `--seed-secret GH_TOKEN='gh auth token'`
through the 3.x line; removed in 4.0.

`.dridock/secrets.env` is gitignored, chmod 600, `KEY=VALUE` per line — the same file
`--secrets-file F` merges into. The wrapper still injects it on every invocation and
persists it to a per-container sidecar that the entrypoint re-reads on each start
(so secrets survive `docker start` — which can't take new `-e`).

## What the entrypoint does (and no longer does)

- **Exports each `KEY=VALUE` from the secrets sidecar into the environment.** Provider
  CLIs (`gh`, `glab`, `hub`) pick up their own env var automatically.
- **Does NOT run `gh auth setup-git`.** This was the credential-helper hijack root
  cause. `git-over-HTTPS` now falls through to SSH the same way it does on the Mac.
- **Does NOT set `credential.https://<host>.helper`.** No harness-owned credential
  helper anywhere — one less thing to get wrong.

## The SSH key

`install.sh` generates `~/.ssh/claudebox/id_ed25519` on the host (path kept from 2.x
for one deprecation cycle) and the wrapper bind-mounts it into the container at the
same path. The installer prints the public-key path and instructs the user to add it
to each git host — that's the one-time setup for git ops. SSH agent forwarding is not
used (the key lives in the container).

## Adding an API token later

Two supported paths (both file-based — never on the command line):

```bash
# from any dir inside the project workspace, seed a single provider:
dridock bootstrap --seed-secret GH_TOKEN='gh auth token'
# (--seed-secret runs 'gh auth token' on the HOST, stores the output in secrets.env)

# or merge a whole file:
dridock bootstrap --secrets-file ./api-tokens.env
```

`.dridock/secrets.env` can also be edited by hand — the wrapper picks it up on the
next invocation.

## Rotating a token

Same recipe as adding one — `--seed-secret` overwrites an existing key of the same
name. Mid-session containers see the new value on the next `dridock` invocation (the
wrapper re-writes the sidecar every run and the entrypoint re-reads it on every
start, so a running container picks up rotations without a rebuild).

## Migration from 2.x

- Existing `.claudebox/secrets.env` files are read by the 3.0 wrapper (backward-compat
  via `cb_project_dot`); `dridock migrate` moves them to `.dridock/secrets.env`.
- Existing `GH_TOKEN` entries keep working — the token is still injected into env; only
  the `gh auth setup-git` boot step goes away.
- Users who relied on the credential-helper for `git push https://github.com/…` need
  to switch their `origin` remote to SSH (`git remote set-url origin
  git@github.com:owner/repo.git`), or explicitly install a credential helper of their
  own choosing. The harness stays out of it.

## See also

- Issue [#10](https://github.com/aberezin/docker-claudebox/issues/10) — this doc's tracking issue.
- [bootstrap.md](bootstrap.md) — the `dridock bootstrap` verb and its secrets flags.
- [../environment-variables.md](../environment-variables.md) — the `.dridock/secrets.env` reference.
- [3.0-migration.md](3.0-migration.md) — where this split lands in the 3.0 bundle.

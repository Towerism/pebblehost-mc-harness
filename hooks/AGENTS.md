# hooks

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
Git hooks that keep server files out of this public repo. `pre-commit`, `pre-merge-commit` and `pre-push` run `bin/path-guard`; `private-pre-push` belongs to the private server repo and refuses any remote that is not its Gitea host. None of them runs from `hooks/` directly: `make hooks` installs stubs that exec the current checkout's copy.

## Key Files
| File | Description |
|------|-------------|
| `pre-commit` | Runs `bin/path-guard --staged`; refuses a commit that stages a path the guard rejects |
| `pre-merge-commit` | Same check as `pre-commit`, for merge commits |
| `pre-push` | For each pushed ref, runs `bin/path-guard --range <base>..<local sha>`. The base is the remote tip, or `origin/main` for a new branch or a remote tip this clone doesn't have (exit 2 when `origin/main` is missing). Skips a branch deletion; refuses a pushed object that is not a commit (a tag of a tree or blob). Sets `GIT_NO_REPLACE_OBJECTS=1` so a replace ref can't show git a clean commit |
| `private-pre-push` | The private repo's pre-push hook, linked by the template's `make hooks`. Allows only remotes on `vcs.martinfrackerjr.com`, strictly `scheme://[user@]host[:port]/path` (ssh, http, https, git) or scp-like `[user@]host:path`; a backslash or a second `@` is refused (exit 2) |

## For AI Agents

### Working In This Directory
- Run `make hooks` in each new clone. `bin/install-hooks` writes stubs to the repo's shared hooks directory (`git rev-parse --git-common-dir`), so every worktree runs its own checkout's `hooks/<name>`, and a checkout without `hooks/` refuses the commit or push. It unsets `core.hooksPath` if that was `hooks`. The hooks run `bin/path-guard`, which exits 2 and lists every refused path; never bypass it with `--no-verify`.
- Cherry-pick and rebase run no commit hook: `pre-push` (every new commit since the remote tip, or since `origin/main` for a new branch) and CI are the gate for those.
- `bin/install-hooks` installs only `pre-commit`, `pre-push` and `pre-merge-commit`, and refuses (exit 2) to overwrite a hook that lacks its marker line `# path-guard stub (bin/install-hooks)`.
- `private-pre-push` is not installed by this repo's `make hooks`. The private repo's `make hooks` symlinks it as `.git/hooks/pre-push` (shared hooks directory) and runs this harness's `bin/install-hooks` for the submodule.
- Keep the hooks thin: the rules live in `src/guard/paths.ts` and `src/guard/cli.ts`. A new hook name needs `bin/install-hooks` updated.

### Testing Requirements
`make test-unit` runs the path-guard hook tests in temp repos (`test/unit/guard.bats`, `test/unit/private.bats`). Run `make lint` (shellcheck) after editing a hook.

### Common Patterns
`#!/usr/bin/env bash`, `set -euo pipefail`; find `bin/path-guard` relative to the hook (`$(dirname "$0")/../bin/path-guard`) and `exec` it; exit 2 for a refusal.

## Dependencies

### Internal
- `bin/path-guard` (and `src/guard/`): the check the public hooks run
- `bin/install-hooks`: installs the stubs for the three public hooks

### External
- `git`, bash

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

# template

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
What a private server repo starts from. The private repo holds the server's files, has this harness as its `harness/` submodule, and pushes only to its Gitea. This file describes the template files for people editing this harness. `template/CLAUDE.md` is different: it is the private repo's own agent guide (the loop from seed to live check) and is copied there as its `CLAUDE.md`; edit it as that guide, not as documentation of this directory. Covers `template/`, `template/bin/` and `template/.claude/`.

## Key Files
| File | Description |
|------|-------------|
| `CLAUDE.md` | The private repo's agent guide: credentials, layout (`server/` on `main` mirrors live, `sync-rules`, `checks/`, `.verify/runs/`, `docs/`, `.dev/`), direct `bin/mc` use, and the loop from seed to live check |
| `bin/mc` | Wrapper: exports `MC_ENV_FILE` (default the repo's `.env`) and `MC_HOME` (default the repo root), then execs `harness/bin/mc`. `pull` and `fetch` are refused (exit 2) unless `MC_HOME` is under `.dev/`: `server/` on `main` comes only from `bin/dev sync`, data from `bin/dev seed N --with-data`. `push` is refused by the harness's `bin/mc` outside `bin/check runbook push` |
| `bin/dev` | Wrapper: sets `MC_HOME` to the repo root and `MC_ENV_FILE`, execs `harness/bin/dev` |
| `bin/check` | Wrapper: sets `MC_HOME` to the repo root and `MC_ENV_FILE`, execs `harness/bin/check` |
| `.gitignore` | Ignores `.env`, `.env.*`, `backups/`, `.mc/`, `.dev/`, `.omc/`, `node_modules/`, plus a section between `# >>> sync-rules` and `# <<< sync-rules` that `bin/dev sync` regenerates from the default `sync-rules` (edit `sync-rules`, not that section) |
| `.claude/settings.json` | Denies Claude reading `.env` (`Read(./.env)` and `Bash` forms of `cat`, `source`, `.`, `head`, `tail`, `less`, `grep * .env`) |
| `.harness-private` | Marks the private repo: `harness/bin/mc` refuses a bare push here; live writes go through `bin/check runbook push N` |
| `package.json` | Private ESM package, Node `>=24.12`, maps `#harness/*` to `./harness/src/check/*.ts` |
| `Makefile` | `setup`: init the submodule, `npm ci` in `harness/`, copy `harness/templates/sync-rules` to `sync-rules` if absent, then `hooks`. `hooks`: link `harness/hooks/private-pre-push` as the shared `pre-push` hook (refuses any remote not on `vcs.martinfrackerjr.com`) and run `harness/bin/install-hooks`. `test`: refuses (exit 2) while either hook is missing, then runs `bin/check suite`. `sync`: `bin/dev sync` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `bin/` | The three wrappers above (documented here, no separate file) |
| `.claude/` | `settings.json` only (documented here) |

## For AI Agents

### Working In This Directory
- Files here are copied into the private repo, so paths in them are relative to that repo (`harness/...`), not to this one.
- `template/CLAUDE.md` is the private repo's guide. Keep it consistent with root `CLAUDE.md`, the wrappers and the Makefile; it is read by agents working on the server, not on this harness.
- Keep the `.gitignore` sync-rules section equal to what `bin/dev sync` generates from `templates/sync-rules`; a change to the default rules changes it.
- The wrappers must keep `bin/mc pull` and `fetch` refused outside `.dev/`; `bin/dev sync` and `seed` reach `bin/mc` through `MC_HOME` under `.dev/`.
- `.claude/settings.json` must keep denying every way of reading `.env`. Never read `.env`.
- The private repo's pre-push gate is `private-pre-push` (see `hooks/AGENTS.md`); `make test` refuses without it and without the submodule's path-guard stubs.

### Testing Requirements
`make test-unit` (`test/unit/private.bats` exercises the private-repo behaviour, including the template wrappers); `make lint` runs shellcheck on `template/bin/*`.

### Common Patterns
Wrappers: `#!/usr/bin/env bash`, `set -euo pipefail`, `root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)`, export env, `exec "$root/harness/bin/<cmd>" "$@"`.

## Dependencies

### Internal
- `bin/mc`, `bin/dev`, `bin/check`, `bin/install-hooks` (in the `harness/` submodule)
- `hooks/private-pre-push`, `templates/sync-rules`

### External
- `git` (submodules, 2.31+ for `--path-format`), `make`, Node 24.12 or later

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

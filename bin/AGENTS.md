# bin

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The `mc` command: list, pull, diff and push the server's files over SFTP.

## Key Files
| File | Description |
|------|-------------|
| `path-guard` | Bash shim that runs `src/guard/cli.ts` with Node: `--staged`, `--range A..B` or `--history REV`, `--profile public\|private`; exit 2 lists every refused path with its reason |
| `install-hooks` | Run by `make hooks`: writes `pre-commit`, `pre-push` and `pre-merge-commit` stubs to the shared hooks directory that exec the current checkout's `hooks/<name>`, or exit 2 when it is missing; refuses to overwrite a hook it didn't write |
| `check` | Bash shim that runs `src/check/cli.ts`: `run <id> [--fresh] [--pod ID] [--issue N] [--timeout S]`, `gate <id> [--no-confirm]`, `postmortem <id>`, `runbook <id>`, `runbook push N [--plan]`, `runbook rollback N`, `suite [--jar NAME] [--heap SIZE]`; exit 0 passed, 1 failed (recorded), 2 refused |
| `dev` | Bash shim that runs `src/dev/cli.ts`: `up`, `rebuild`, `restart`, `reset`, `down`, `status`, `logs`, `boot-report [--against LOG]`, `join`, `bot join|chat|wait|quit|list ...` (bot sessions in the relay), `sync [--full]`, `seed N [--with-data P...] [--with-worlds] [--no-boot]`, `inventory [--wait S]`, `console <command...>` (options first; the first other word, or what follows `--`, starts the server command; prints the RCON reply); `--pod ID` (default `dev`), `--jar NAME`, `--heap SIZE`. Uses `$MC_HOME/server/` and `$MC_HOME/.dev/`. `MC_JAVA_OPTS` and `MC_DEV_MEMORY` size the server. `down --all` also removes the checkout's `mc-dev` images. Exit 2 on any refusal |
| `mc` | Bash script. In a private repo (`.harness-private` in `MC_HOME` or in the superproject of this harness) `push` refuses unless `MC_RUNBOOK=1`. After `--`, the argument is a path even when it starts with `-`. An empty remote directory pulls as nothing and diffs as all-new. `ls -R` lists every file below a path; `MC_EXCLUDE_FILE` (an rclone exclude file, relative to the path transferred) applies to every listing and directory transfer, for `bin/dev sync`; `MC_FILTER_FILE` (an rclone filter file) applies to listings, for sync's one-call listing; `fetch` copies the paths on stdin into `server/` (`--files-from-raw`, nothing recorded), refusing any that leaves the server root. Parses `.env` without sourcing it, maps it to `RCLONE_CONFIG_PEBBLE_*` environment variables (password obscured through stdin), and runs rclone with `RCLONE_CONFIG=/dev/null` |

## For AI Agents

### Working In This Directory
- Paths go through `clean_path`: relative to the server root, no `..`. `pull`, `diff` and `push` on the root need `--all`.
- `MC_HOME` (default: the repo root) holds `.env`, `server/`, `backups/` and `.mc/`; tests point it at a temp directory. When `MC_HOME` is the top of a linked git worktree of a non-bare repo, `main_checkout` finds the main checkout (ignoring any inherited `GIT_DIR`): `.env` comes from there when the worktree has none and `MC_ENV_FILE` is unset, and `backups/` is always there. `server/` and `.mc/` stay in the worktree.
- `ls -l` reads `rclone lsf --format stp`; the name is the last field so a `|` in it survives, and size `-1` (a directory) prints as `-`. `-l` with any other command is an error.
- Exit codes: 0 ok, 1 `diff` found differences, 2 error (`die`). Keep that split.
- The password must never reach argv, output or any written file.
- Push safety relies on: the remote listing recorded *before* the pull's copy; the listing compared again before upload; the remote copy saved to `backups/<ts>/remote/` before upload; `--ignore-times` on transfers (SFTP modtimes have 1-second precision).
- The push upload alone uses `--inplace`: PebbleHost's SFTP refuses renaming rclone's `.partial` file over the target. Pull, diff and the backup download stay atomic.

### Testing Requirements
`make lint test-unit test-integration`. A new behaviour gets a unit test in `test/unit/mc.bats`, and an integration test when it touches real SFTP semantics.

### Common Patterns
`set -euo pipefail`; one `cmd_<name>` function per command; state paths from `state_file remote|local <path>` (sha1 of the path); the per-run scratch directory `$tmp` is removed by an EXIT trap.

## Dependencies

### External
- `rclone` (`lsf`, `copyto`, `obscure`), coreutils, `diff`, `find`, `sha1sum`
- `git` (optional, 2.31+ for `--path-format`): only to detect a linked worktree

## Manual Notes

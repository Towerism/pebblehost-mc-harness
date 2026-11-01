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
| `mc` | Bash script. Parses `.env` without sourcing it, maps it to `RCLONE_CONFIG_PEBBLE_*` environment variables (password obscured through stdin), and runs rclone with `RCLONE_CONFIG=/dev/null` |

## For AI Agents

### Working In This Directory
- Paths go through `clean_path`: relative to the server root, no `..`. `pull`, `diff` and `push` on the root need `--all`.
- `MC_HOME` (default: the repo root) holds `.env`, `server/`, `backups/` and `.mc/`; tests point it at a temp directory.
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

## Manual Notes

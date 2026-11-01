# unit

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
Unit tests for `bin/mc`: `.env` parsing, the mapping to rclone variables, path safety, root `--all` guards, conflict refusal, backup ordering, password secrecy and the linked-worktree `.env` and `backups/` paths (`make_worktree` builds a throwaway repo and worktree). No network.

## Key Files
| File | Description |
|------|-------------|
| `mc.bats` | The unit tests; `setup` writes a `.env` with a password containing `$` and quotes |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `stub/` | Fake `rclone` put first on `PATH` (see `stub/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Assert on the stub's records: `$STUB_LOG` (argv per call, in order), `$STUB_ENV` (`RCLONE_CONFIG_PEBBLE_*` at the last call), `$STUB_OBSCURED` (stdin given to `rclone obscure`). Set `$STUB_LSF` to control what `rclone lsf` returns.
- Use `run ! cmd` for negative checks, not a bare `! cmd`: bash's `set -e` ignores `!`, so a bare one only works as a test's last line.
- Errors from `mc` exit 2.

### Testing Requirements
`make test-unit` (`bats --jobs 8`); tests must stay independent so they can run in parallel.

## Manual Notes

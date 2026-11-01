# test

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
bats suites for `bin/mc`, split by cost: unit (no network, under 2s), integration (one local SFTP container), live (read-only against the real server).

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `unit/` | Fast tests against a fake rclone (see `unit/AGENTS.md`) |
| `integration/` | End-to-end tests against a shared `atmoz/sftp` container (see `integration/AGENTS.md`) |
| `live/` | Opt-in read-only smoke test against the real server (see `live/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Run through the `Makefile` targets; they set `--print-output-on-failure` and the job count.
- Tests set `MC_HOME` to `$BATS_TEST_TMPDIR` and write their own `.env`; nothing touches the repo's `.env` except `live/`.
- Name tests for the behaviour they check, not for spec IDs.

### Testing Requirements
Keep the unit suite under 2s and the integration suite at one container per run.

## Manual Notes

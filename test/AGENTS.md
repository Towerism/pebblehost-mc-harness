# test

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
bats suites for `bin/mc` and the path-guard hooks, plus `node --test` unit tests for the TypeScript in `src/`, split by cost: unit (no network, under 2s), integration (one local SFTP container), live (read-only against the real server).

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `unit/` | Fast tests against a fake rclone, and `guard.bats` for the hooks in a temp git repo (see `unit/AGENTS.md`) |
| `ts/` | `*.test.ts` run by `node --test` in `make test-unit`; `guard.test.ts` covers every guard rule and the cap boundary |
| `integration/` | End-to-end tests against a shared `atmoz/sftp` container (see `integration/AGENTS.md`) |
| `live/` | Opt-in read-only smoke test against the real server (see `live/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Run through the `Makefile` targets; they set `--print-output-on-failure` and the job count.
- Tests set `MC_HOME` to `$BATS_TEST_TMPDIR` and write their own `.env`; nothing touches the repo's `.env` except `live/`.
- Name tests for the behaviour they check, not for spec IDs.
- Generate fixtures (server trees, git repos, big files) inside the test's temp directory at run time. Never commit them: the path guard refuses `server/`, `plugins/`, `*.jar` and the like even under `test/`.

### Testing Requirements
Keep the unit suite under 2s and the integration suite at one container per run.

## Manual Notes

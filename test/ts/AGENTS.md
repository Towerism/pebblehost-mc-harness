# ts

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
`node --test` tests for the TypeScript under `src/` (`src/dev/`, `src/check/`, `src/relay/`, the guard and sync rules). They need no network and no Docker: docker and rclone are replaced by fake scripts written into temp directories.

## Key Files
| File | Description |
|------|-------------|
| `project.ts` | Shared helpers, not a test: `project()` builds a temp git project on branch `issue/3` with a tracked `server/` and `.verify/` (no import map, since `bin/check run`'s loader resolves `#harness/*`); `fakeDocker()` writes a docker stand-in for one running pod whose answers (`FAKE_*`) are baked into the script because checks run with an allow-listed env; `check()` runs `bin/check` with it; `E2E` and `LABELS` are fixtures |
| `guard.test.ts` | Every path-guard rule and the cap boundary |
| `dev.test.ts` | `src/dev/` with a recording fake docker |
| `check.test.ts` | `bin/check run` in a temp project from `project.ts` |
| `check-isolation.test.ts` | The run's env, the `#harness/*` loader, bare-text directory contents and committed-file reads |
| `gate.test.ts` | Every gate rule and refusal case, and the G8 static check |
| `gate-cli.test.ts`, `gate-g8.test.ts`, `gate-confirm.test.ts` | `gate`, `postmortem` and `runbook` end to end on the same helpers; split into three files so they run in parallel |
| `suite.test.ts` | Profile validation, suite grouping and the reset plan, the restart declaration, the timings table, and a refused check not stopping the rest |
| `suite-signal.test.ts` | SIGINT and SIGTERM sent to `bin/check suite` mid-run |
| `bots.test.ts` | The relay's bot sessions with a fake mineflayer |
| `relay.test.ts` | `src/relay/` against an in-process fake RCON server, and `bin/dev console` with a fake docker |
| `live.test.ts` | `--target live` refusals, skips and exit codes without SFTP |
| `live-pull.test.ts` | Live reads through `bin/mc` and a fake rclone over a local tree: directories refused before any copy, a database listing that changes during its pulls refusing the run, SIGINT/SIGTERM to `bin/check run` killing the check and removing the live home, stale run homes swept |
| `runbook.test.ts` | The push set of `main...issue/N`, drift on `main`, and the `runbook push`/`rollback` refusals before any transfer (sync-rules path, no runbook, no check or gate pass, not on `issue/N`, drift, no journal) |
| `rules.test.ts` | `sync-rules` parsing and matching (`**/` and `/**/` as zero or more directories, trailing `/` for directories only, any case), rclone excludes, the generated `.gitignore` section, the defaults, and the private guard reading them |
| `sync.test.ts` | `bin/dev sync` and `seed` over a fake rclone: a file rewritten mid-copy fails the sync once with no drift commit, a skip path given to `--with-data` refused before anything runs; the incremental listing's parse, window and diff; the `OVER BUDGET` line; `mc()` dropping an inherited `MC_EXCLUDE_IGNORE_CASE` |

## For AI Agents

### Working In This Directory
- Name new files `*.test.ts`; the glob `test/ts/**/*.test.ts` picks them up. `project.ts` is imported, never run.
- Node >= 24.12 runs TypeScript directly (`node:sqlite` is used too); `make lint` type-checks with `tsc --noEmit`.
- Build trees (git repos, server files) in a temp directory at run time; commit no fixtures.
- Tests that spawn `bin/check` or `bin/dev` pass an explicit env (`ENV` from `project.ts` sets `GIT_CONFIG_GLOBAL=/dev/null`); set `MC_DOCKER` to a fake docker, never the real one.
- Keep files small enough to run in parallel; split a file rather than serialising it.

### Testing Requirements
`make test-unit-ts` (`node --test 'test/ts/**/*.test.ts'`), also run by `make test-unit` alongside the bats unit suite. Run `npm ci` once first. Run `make lint` after adding a file.

### Common Patterns
- `fakeDocker({...FAKE_*})` plus `check(root, env, ...args)` for anything that talks to a pod.
- `project({...files})` then `commit(root, {...})` to build the history a gate rule needs.
- A fake rclone over a local tree stands in for SFTP in the sync and live tests.

## Dependencies
- Node >= 24.12, `git`, `bin/check`, `bin/dev`, `bin/mc` and `src/`.
- `#harness/dev`, `#harness/bot` and `#harness/unit`, resolved by `bin/check run`'s loader.
- No Docker and no network.

## Manual Notes
Notes under this heading are written by humans and preserved on regeneration.

# test

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
bats suites for `bin/mc` and the path-guard hooks, plus `node --test` unit tests for the TypeScript in `src/`, split by cost: unit (no network, under 2s), integration (one local SFTP container), live (read-only against the real server).

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `unit/` | Fast tests against a fake rclone, and `guard.bats` for the hooks in a temp git repo (see `unit/AGENTS.md`) |
| `ts/` | `*.test.ts` run by `node --test` in `make test-unit`; `guard.test.ts` covers every guard rule and the cap boundary; `dev.test.ts` covers `src/dev/` with a recording fake docker; `check.test.ts` covers `bin/check run` in a temp project from `project.ts` (tracked `.verify/`, no import map: the loader resolves `#harness/*`), with a fake docker whose answers are baked into its script; `check-isolation.test.ts` covers the run's env, the `#harness/*` loader, bare-text directory contents and committed-file reads; `gate-cli.test.ts`, `gate-g8.test.ts` and `gate-confirm.test.ts` drive `gate`, `postmortem` and `runbook` end to end on the same helpers (split so they run in parallel); `gate.test.ts` covers every gate rule and refusal case and the G8 static check; `suite.test.ts` covers profile validation, suite grouping and the reset plan, the restart declaration, the timings table and a refused check that doesn't stop the rest; `suite-signal.test.ts` sends SIGINT and SIGTERM to `bin/check suite` mid-run; `bots.test.ts` covers the relay's bot sessions with a fake mineflayer; `live.test.ts` covers `--target live` refusals, skips and exit codes without SFTP; `live-pull.test.ts` drives live reads through `bin/mc` and a fake rclone over a local tree (directories refused before any copy, a database listing that changes during its pulls refusing the run, SIGINT/SIGTERM to `bin/check run` killing the check and removing the live home, stale run homes swept); `runbook.test.ts` covers the push set of `main...issue/N`, drift on `main`, and the `runbook push`/`rollback` refusals before any transfer; `rules.test.ts` covers `sync-rules` parsing, matching, excludes, the `.gitignore` section, the defaults and the private guard reading them; `relay.test.ts` covers `src/relay/` against an in-process fake RCON server, and `bin/dev console` with a fake docker |
| `integration/` | End-to-end tests against a shared `atmoz/sftp` container (see `integration/AGENTS.md`) |
| `dev/` | `make test-dev`: `bin/dev` against Docker and vanilla Purpur 26.1.2. `prime` downloads it and lets paperclip fetch its libraries once into `~/.cache/mc-harness/`; `setup_suite.bash` commits it as `server/` in a temp project; `dev.bats` tests share one pod in file order; `seed.bats` serves the primed Purpur tree from its own atmoz/sftp container as live: `bin/dev seed 7` syncs it to `main`, cuts `issue/7` and boots a pod with opt-in data, and a re-seed keeps the issue commits and leaves nothing of the old pod or data; `suite.bats` runs `bin/check suite` twice over three profiles (no fixtures with an undeclared `dev.restart()` that fails; fixtures restored by copy with a declared restart; vanilla IP bans as declared data, reset by a restart) plus a bare-text check: same results, cached image the second time, one boot and teardown per profile, nothing left; then SIGINT and SIGTERM to `bin/check` mid-boot exit 130 and 143 with every suite pod removed; `verify.bats` runs after it: `bin/check run` red on a fresh volume, the explored marker surviving a deleted `.dev/`, a hand-made green refused (G3), a no-op commit plus a console repair refused (G9, explored green), another check repairing the server before the green refused (G9, not the first run on its volume), two parallel runs on a new volume getting positions 0 and 1 with the overlap flagged, uncommitted records refused (G10), green only after a fix commit and `rebuild`, the gate with its confirm run, postmortem and runbook, and an explored red refused (G9); `egress-probe` runs inside the container; `budget.json` is the vanilla boot baseline |
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

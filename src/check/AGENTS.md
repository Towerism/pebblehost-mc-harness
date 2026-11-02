# check

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
`bin/check`: runs committed checks (`checks/<id>/profile.json` plus `*.test.ts`, run by `node --test`), records each run as evidence, runs the whole suite, drives the gate (see `../gate/AGENTS.md`), and provides the APIs checks import (`#harness/dev`, `#harness/bot`, `#harness/unit`). The read-only live target runs the same checks against the real server.

## Key Files
| File | Description |
|------|-------------|
| `cli.ts` | Entry behind `bin/check`: `run`, `gate`, `postmortem`, `runbook` (and `runbook push N`/`rollback N`, which call `../sync/runbookPush.ts`), `suite`. Exit 0 passed, 1 failed (recorded), 2 refused (`DevError`). `run` and `gate` re-exec themselves in a child (`MC_RUN_CHILD=1`) so the parent can react to SIGINT/SIGTERM: it kills the child's process group (the check's `node --test` with it), removes the run's live home and exits 130/143. `confirmedPass` is what `postmortem`, `runbook` and `runbook push` require: gate pass, a confirm, and the confirm committed as is (G10). `gatedIssue` requires the project on `issue/N` and a confirmed pass for every committed `checks/N-*`. `--target live` is for `run` and `suite` only |
| `run.ts` | `runCheck` (identity from the running container's labels for e2e, from a clean HEAD for bare-text; appends a record), `runTests` (`node --test` with `--import loader.ts`; reads the TAP file: a file defining no test, a refused import or a changed live database makes the run refuse with nothing recorded), `committedTests`, `checkHash`, `checkEnv`, `startLive`/`sweepLiveRuns`, `refuseDirtyHarness` |
| `record.ts` | `RunRecord` and `.verify/runs/issue-N.jsonl`: `issueOf` (from `--issue` or branch `issue/N`), `appendRecord`, `readRecords`, `runsFile` |
| `profile.ts` | `profile.json` validation (`readProfile`): `kind`, `fixtures`, `data`, `needs`, `restart`, `exclusive`, `sqlite`; unknown keys refused; a bare-text check takes none of the others. `fixtureDirs`, `sqliteFixtures`, `isData` (`*.db`/`*.sqlite*` and `-wal`/`-shm`/`-journal` are always data) |
| `suite.ts` | `planSuite` groups e2e checks by merged fixtures hash (an `exclusive` check gets its own group; `restart` checks run last) and picks the reset between checks: `reset` (restart that re-applies fixtures) when any check has data, else `restore` (copy `/fixtures` over `/server`) when any has fixtures, else `none`. `runSuite` boots one pod (`suite0`, `suite1`, ...) per group, runs, and tears each down pass or fail; a check that can't run (bad profile, conflicting fixtures, uncommitted, no tests) is `REFUSED` and the rest still run. `teardownSuitePods` removes every `suite<N>` pod of the project by label |
| `timings.ts` | `timings.json` (`.dev/runs/<ts>/`, 0600), the printed table (`formatTimings`) and `checks/budget.json` (`readBudget`; `OVER BUDGET by Ns`) |
| `dev.ts` | `#harness/dev`: `dev.console(cmd)`, `dev.logSince(t)`, `dev.file(path)`, `dev.sqlite(path, sql, ...params)` (read-only copy of the db with its `-wal`/`-shm`), `dev.restart()`, `dev.reset()` |
| `bot.ts` | `#harness/bot`: `bot.join(name)` returns `chat`, `waitMessage(regex)`, `quit`; `bot.list()`. Calls go to the pod's relay (see `../relay/AGENTS.md`) |
| `unit.ts` | `#harness/unit`: `test` and `bareText(file, path, literal)`, which reads the file as committed (`git show $MC_COMMIT:server/<file>`); `.properties` takes a key, YAML a dotted path to a single-line scalar |
| `live.ts` | The read-only live target: `livePull` runs `bin/mc pull` into `MC_LIVE_HOME` with `MC_ENV_FILE`; `refuseOnLive` throws `LiveReadOnlyError`, marked `MC_LIVE_SKIP` when `MC_NEEDS` declares the need, which `runTests` counts as skipped from the TAP diagnostics |
| `loader.ts` | The `--import` hook (`registerHooks`) that pins `#harness/dev`, `#harness/bot` and `#harness/unit` to this harness whatever any `package.json` maps, and lets a check's files import only files in their own `checks/<id>/` (`MC_CHECK_DIR`), `node:` built-ins and packages; no module may load a `data:`, `http:` or other non-file URL. A refused import makes `bin/check run` exit 2 without a record. Committed symlinks in a check are refused too (`committedTests`). This confinement is hygiene against shared helpers changing between red and green, not a sandbox: an e2e check can still use `fs` or `child_process`, so reviewers read the check |

## For AI Agents

### Working In This Directory
- `bin/check suite` runs `runSuite` in a detached child (`MC_SUITE_CHILD=1`; `suiteParent` in `cli.ts`). On SIGINT/SIGTERM the parent kills the child's process group, sweeps the suite pods until a pass finds none (a docker call the kill cut short can still create a resource), and exits 130/143. At start it kills an orphaned child recorded in `.dev/suite.pid` (`killOrphanSuite` in `../dev/pod.ts`, only when `/proc/<pid>/environ` shows `MC_SUITE_CHILD=1` and this `MC_HOME`; `bin/dev down --all` does the same) and removes leftover suite pods.
- `bin/check run` runs only the `*.test.ts` of the committed `checks/<id>` tree and refuses uncommitted changes and any untracked or ignored file in that directory. A bare-text directory may hold only `profile.json` and `*.test.ts`.
- `node --test` starts with an allow-listed env (`KEEP_ENV` in `run.ts`: `PATH`, `HOME`, `TZ`, locale, `TMPDIR`, docker variables) plus `MC_HOME`, `MC_POD`, `MC_TARGET`, `MC_COMMIT` and the profile-derived `MC_NEEDS`, `MC_RESTART_OK`, `MC_CHECK_DIR`: no `NODE_OPTIONS` or other `NODE_*` from the caller.
- Records read identity from the container labels, never HEAD; `bin/check run` refuses uncommitted harness code (`refuseDirtyHarness`) so `harnessHash` and `toolHash` name committed code. Record fields are in `record.ts`; `bin/check run --fresh` boots HEAD on a new volume first (e2e only).
- Each e2e run appends `<time> issue-N <id> [confirm]` with a nonce to the volume's run log in one `O_APPEND` write, and re-reads it after the tests: `runIndex` is the nonce line's position, `concurrent` is set when a line follows it or it vanished; `explored` is checked before and after. Bots from a previous run leave before and after (`bot.quitAll`, no log line, no explored mark). A check's own `dev.console`, `dev.*` and bot calls don't mark the volume explored.
- A bare-text record reads a clean HEAD, and `bareText` reads files from `MC_COMMIT`, never the working tree.
- Live runs (`--target live`): files, the log and databases are pulled through `bin/mc pull` into a 0700 `.dev/live/run-*` home that is removed after the run; sweeping removes homes whose owner process is gone. `livePull` lists the parent first and refuses a directory, a trailing `/`, an empty or `.` segment before any copy. `dev.sqlite` pulls the db, `-wal` and `-shm` only when their listing (size, modtime) is the same before and after; one retry, then the run is refused (exit 2, nothing recorded) with "live database changed during pull". A run is recorded with `target: "live"`, never counts for the gate, and exits 2 with nothing recorded when no test ran; the live suite prints SKIP for such checks and exits 2 when none ran.
- `dev.restart()`/`dev.reset()` throw unless the profile declares `restart` or `exclusive` (`MC_RESTART_OK`).
- Suite between checks on a pod: bots leave; `reset` restarts with fixtures applied, `restore` copies `/fixtures` over the running server (it deletes nothing and does not reset in-memory plugin state, so declare `data` for plugins with state).
- Exit-code contract: keep 0/1/2 (and 130/143 for signals).

### Testing Requirements
`make test-unit` runs `test/ts/`: `check.test.ts` (`run` in a temp project from `project.ts` with a fake docker), `check-isolation.test.ts` (run env, `#harness/*` loader, bare-text directory contents, committed-file reads), `suite.test.ts` (profile validation, grouping, reset plan, restart declaration, timings table, refused check not stopping the rest), `suite-signal.test.ts` (SIGINT/SIGTERM mid-run), `live.test.ts` (live refusals, skips, exit codes), `live-pull.test.ts` (live reads through `bin/mc` and a fake rclone, SIGINT/SIGTERM to `run`, stale homes), `bots.test.ts` (relay side of `#harness/bot`). The gate files are listed in `../gate/AGENTS.md`. `make test-dev` runs `test/dev/suite.bats` and `verify.bats` against a real pod.

### Common Patterns
Failures throw via `fail()` from `../dev/docker.ts` (`DevError`); `cli.ts` turns them into `check: <message>` and exit 2. Pod access goes through `podOf`/`names`/`relayRequest` from `../dev/pod.ts`; `docker` is injected so tests substitute a fake.

## Dependencies

### Internal
- `../dev/` (`cli.ts` `boot`, `docker.ts`, `image.ts` for `git`, `source`, `labels`, `toolHash`, `dirtyHarness`; `pod.ts` for pods, run log, explored marker, `relayRequest`, `killOrphanSuite`; `overrides.ts` `findYaml`)
- `../gate/` (`gate.ts`, `bareText.ts`, `docs.ts`)
- `../sync/runbookPush.ts`
- `../relay/` (reached through the pod's relay socket)
- `bin/mc` (live target)

### External
- `node:test`, `node:sqlite`, `node:module` hooks; `git`; Docker

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

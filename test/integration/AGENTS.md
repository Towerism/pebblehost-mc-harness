# integration

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
End-to-end tests for `bin/mc` with real rclone against a local SFTP server.

## Key Files
| File | Description |
|------|-------------|
| `setup_suite.bash` | Starts one `atmoz/sftp:alpine` container for the whole run (user `mc`, a password containing `$` and a space, random localhost port, writable `upload/`), waits for sshd, and removes it in `teardown_suite` (it also runs when setup fails) |
| `mc.bats` | Scenarios: root push with `--all`, ls, `ls -l` sizes, pull → edit → diff → push, backup contents, refusal after a remote change, remote deletes not resurrected, wrong password not echoed |
| `runbook.bats` | `bin/check runbook push` and `rollback` with the container's root as live: only `server/` files go up (a new directory included, its siblings untouched), with backups and a journal, and rollback's printed commands restore live; drift on live and on `main` refused before any write; an upload failing on the 2nd of 3 files leaves 1 ok and 1 failed in the journal, with backups after the run. Resets the container root's server tree before each test |
| `sync.bats` | `bin/dev sync` with the container's root as live: drift committed on `main` only, no commit for no change or data-only changes, the private guard refusing a database the rules let through, a tracked file turned data untracked in its own commit, refusals when `main` is checked out or `.dev/sync` is off `main`, `seed --no-boot` reusing `issue/N` and replacing `.dev/seed-N`, `inventory` review entries for a file rewritten between its listings. Resets the container root's server tree before each test |
| `target-live.bats` | `bin/check run` and `suite --target live` with the container as live: file, `logs/latest.log` and SQLite reads through `bin/mc pull`, a declared console need skipped, an undeclared one failing, a bot-only check exiting 2, records `target: live`, nothing pulled kept. Sorts after `mc.bats` on purpose (it seeds `/home/mc/logs` as root) |

## For AI Agents

### Working In This Directory
- Each test works in its own remote tree `upload/t$BATS_SUITE_TEST_NUMBER`, so the container is never reset between tests. Keep new tests in their own tree.
- `remote_sh` runs a shell command in the container as the SFTP user (cwd `/home/mc`); use it to seed or change remote files.
- The root-push test runs first so the root holds only its own tree. The suite runs serially because that test would race with the others.
- `RCLONE_RETRIES=1` and `RCLONE_LOW_LEVEL_RETRIES=1` keep failures fast.

### Testing Requirements
`make test-integration` (Docker required). Each rclone call costs about 200ms for the SSH handshake; avoid needless calls in new tests.

## Manual Notes

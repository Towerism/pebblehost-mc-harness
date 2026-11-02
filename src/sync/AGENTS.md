# src/sync

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
Keeps `main` of the private server repo a mirror of live (`bin/dev sync`, `seed`, `inventory`), holds the `sync-rules` format those tools and the private guard share, and puts a verified fix on live (`bin/check runbook push N` and `rollback N`).

## Key Files
| File | Description |
|------|-------------|
| `rules.ts` | `sync-rules`: `parseRules` (`<skip\|data\|review> <pattern>` lines; `..` and `!` refused), `readRules` (the project's file, else `templates/sync-rules`), `ruleRegex` and `matchRule` (gitignore-style matching, ignoring case), `rcloneExcludes` (rclone patterns that match the same: `\`, `{}`, `[]` escaped, `**/` as `{**/,}`; excludes relative to each pulled directory), `gitignoreSection` and `writeGitignore` (the generated `.gitignore` section) |
| `sync.ts` | `bin/dev sync` in the `.dev/sync` worktree of `main` (`syncLive`): a full pull the first time or with `--full`, after that one listing (`listLive`) diffed against `.dev/sync-listing.json` (`diffListing`) and only changed files fetched through `bin/mc fetch`. `seedData` / `issueBranch` / `refuseSkipped` (`seed` with opt-in data fixtures), `inventory` (review entries). Also the `mc` helper that runs `bin/mc` with its own `MC_HOME` and the project's `.env` path |
| `runbookPush.ts` | `bin/check runbook push N [--plan]` (`runbookPush`, `pushSet`, `mainDrift`) and `runbook rollback N` (`runbookRollback`, restore commands). Needs the committed runbook and a confirmed gate pass for every `checks/N-*`; skip and data paths refused; push set of `main...issue/N`, drift on `main` and live refused before any write, new files through the deepest existing directory with its other entries excluded, a journal and backups in `.dev/runbook-N/` |

## For AI Agents

### Working In This Directory
- Main mirrors live. `sync` keeps `main` checked out in `.dev/sync`, never in the project itself (`worktree` refuses when `main` is checked out in the project, or when `.dev/sync` is on another branch). It runs `reset --hard` and `clean` there first: the worktree belongs to sync. It commits `live drift: <n> files` on `main` only when something changed, after `bin/path-guard --staged --profile private`; a refused drift is reset and nothing is committed.
- Sync roots are `SYNC_ROOTS` (`server.properties`, `bukkit.yml`, `spigot.yml`, `eula.txt`, `start.sh`, `config`, `plugins`, `libraries`, `versions`, `cache`) plus root jars. The first sync, `--full`, or one whose stored listing is missing or no longer matches `main`'s `server/` tree (`Stored.tree`) pulls every root whole (`fullPull`). After that, every sync lists all roots in one recursive call (`ls -R -l` with `MC_FILTER_FILE`; `RCLONE_CHECKERS` 16, `MC_SYNC_CHECKERS` overrides; live's SFTP refuses heavier concurrency), compares it with the stored listing, downloads only new, resized and re-dated files through `bin/mc fetch`, and deletes files gone from live, pruning the directories that leaves empty (removals first, since live may replace a directory with a file).
- Window: a file dated at or after the last listing's window (`WINDOW_S` = 120 s before its start or the newest live mtime, whichever is earlier, `windowStart`) is downloaded again (`recheck`), since a same-size rewrite in the same second keeps its modtime and the two clocks may differ. A sync with no change therefore re-fetches the newest files and makes no commit. The listing is written only once `main` holds what it describes (`done`). It prints its wall time, plus `OVER BUDGET` when an incremental sync with no changed files took over `BUDGET_S` (30 s) (`timing`).
- rclone retries once (`RCLONE_RETRIES=1`). A file live rewrites mid-copy stops the sync (exit 2) instead of looping over re-downloads: `transferFailed` quotes rclone's lines naming the file and says to run it again; no drift is committed. A rule removed or added needs no full pull: the newly included files download and the newly excluded ones go.
- `sync-rules` classes: `skip` is never transferred or committed (`plugins/ajLeaderboards/past-resets/`, `logs/`, ...), `data` is pulled only by `seed --with-data` and never committed (`*.db`, `userdata/`, ...), `review` entries are proposals with no effect. Patterns are relative to the server root; one with a slash before its end is anchored, otherwise it matches a name at any depth. Matching ignores case, like the private guard. Unmatched paths are synced and tracked.
- `sync` regenerates the `.gitignore` section from the rules, and untracks files a new skip or data rule covers in their own `chore: untrack plugin data (<pattern>)` commit (`chore: untrack skipped paths (...)` for skip). Rules reach `bin/mc` as `MC_EXCLUDE_FILE` with `MC_EXCLUDE_IGNORE_CASE=1` (`RULES_CASE`), so rclone matches ignoring case, with `**/` also matching zero directories. `mc()` drops an inherited `MC_EXCLUDE_FILE`, `MC_FILTER_FILE` and `MC_EXCLUDE_IGNORE_CASE` unless the caller sets them: other excludes (runbook push's) stay exact-case. After a full pull or a seed, anything the rules still cover is removed (`dropCovered`). rclone takes no filters on a single file, so a covered single file is left out in `pull`.
- `seed N [--with-data PATH...] [--with-worlds] [--no-boot]` (`refuseSkipped` first, then `issueBranch`, then `seedData`) syncs, puts the project on `issue/N` (reusing it and its commits, or cutting it from the synced `main`; it refuses uncommitted work), replaces `.dev/seed-N` with fresh pulls of the opt-in paths, and the CLI boots a new pod with them as fixtures. A `--with-data` path a skip rule covers is refused before anything runs. If the data paths held no files, it returns no fixtures and the pod boots with none.
- `inventory [--wait S]` lists `plugins/` twice, S seconds apart (default 300), and commits `review` entries to `main`'s `sync-rules` for files that changed and data-like directory names (`*data`). Make each one `skip` or `data`, or delete it.
- Runbook push: it uploads only the `server/` files of `main...issue/N`, prefix stripped. Other paths (`checks/`, `docs/`) are printed as "not pushed", and deleted files as manual steps (`bin/mc` never deletes). It refuses a file a skip or data rule covers, anything under `server/` that is not a regular file on both sides (symlink, typechange, submodule), and a name with a segment starting with `-` or holding a newline (`bin/mc` takes the path after `--`). `--plan` runs all the same checks (`requireRunbook`, `requireGate`) so an OK'd plan is never refused at push.
- Before writing anything, `prepare` refuses if `main` changed any file of the set after `issue/N` was cut (`mainDrift`), and pulls each file into the persistent `.dev/runbook-N/home/` (0700), refusing if live's copy is no longer `main`'s. A new file goes up through the deepest directory live already has, with everything else there excluded (`Unit.exclude`); a new path at the top of the server root is refused (upload by hand), and so is a path live already has. `--plan` stops after printing the set and the `bin/mc diff` of each file. Otherwise each unit is pushed with `MC_RUNBOOK=1`, journalled in `.dev/runbook-N/journal.jsonl` with its backup under `.dev/runbook-N/home/backups/`, and the run stops at the first failure.
- `runbook rollback N` only prints the restore commands of the last run (pull, copy the backup back, push with `MC_RUNBOOK=1`), plus new files to delete by hand. Run them only after the user's OK. In a private repo `bin/mc push` refuses without `MC_RUNBOOK=1`.
- `.env` is never read here; `envFile` only names the path (`MC_ENV_FILE`, else `<root>/.env`) that `bin/mc` loads.

### Testing Requirements
`make test` (lint, unit, integration). Unit: `test/ts/rules.test.ts` (`rules.ts`), `test/ts/sync.test.ts` (`parseListing`, `windowStart`, `diffListing`, `timing`, `mc`), `test/ts/runbook.test.ts` (`pushSet`, `mainDrift`). Integration against a real SFTP container: `test/integration/sync.bats` (sync, seed, inventory) and `test/integration/runbook.bats` (runbook push and rollback); `test/dev/seed.bats` covers `seed` with a pod (`make test-dev`). `test/unit/mc.bats` and `test/unit/guard.bats` cover the `bin/mc` and private-guard sides of the rules.

### Common Patterns
- Failures are `fail(msg)` from `../dev/docker.ts` (a `DevError`: the CLI prints it and exits 2).
- Git runs through `git()` from `../dev/image.ts` (`GIT_NO_REPLACE_OBJECTS=1`); `mustGit` fails with the command and stderr.
- Pure parsing and diffing (`parseListing`, `diffListing`, `pushSet`) are exported separately from the effectful steps so tests need no remote.

## Dependencies

### Internal
- `../dev/docker.ts`, `../dev/image.ts` (`fail`, `git`, `HARNESS_ROOT`, `privateDir`); `../dev/cli.ts` calls `syncLive`, `seedData`, `issueBranch`, `inventory`, `refuseSkipped`; `../check/cli.ts` calls `runbookPush` and `runbookRollback`
- `../../bin/mc` (`pull`, `ls`, `diff`, `push`, `fetch`), `../../bin/path-guard`, `../../templates/sync-rules` (defaults)

### External
- `git` (worktrees), rclone through `bin/mc`, `sleep`

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

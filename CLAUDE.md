# PebbleHost Minecraft server harness

This repo lets Claude work on the files of one Minecraft server hosted on PebbleHost. Server files are reached over SFTP through `bin/mc`; there is no console or restart access yet.

## Credentials: `.env`

`.env` in the repo root holds the panel sign-in and server name. Never read, print, grep or source it: `bin/mc` loads it itself, and `.claude/settings.json` denies reading it. If `mc` reports a missing variable, ask the user to fix `.env`; the variable names are in `.env.example`:

- `PEBBLE_SFTP_HOST`, `PEBBLE_SFTP_PORT` (default 2022), `PEBBLE_SFTP_USER`: from the panel's Files → SFTP Credentials.
- `PEBBLE_PANEL_PASSWORD`: the game panel password, which is also the SFTP password.
- `PEBBLE_SERVER_NAME`: the server's display name. Use it when talking about the server; no command needs it.

## `bin/mc`

Paths are relative to the server root (`plugins/CrateReloaded/crates/vote.yml`); absolute paths and `..` are refused.

| Command | Does |
|---|---|
| `bin/mc ls [path] [-l]` | list one remote directory level; directories end in `/`. `-l` (`--long`) adds the size in bytes (`-` for directories) and the modtime (UTC) |
| `bin/mc pull <path>` | copy a remote file or directory into `server/<path>`, replacing the local copy, and record the remote listing |
| `bin/mc diff <path>` | unified diff remote → `server/<path>`; exit 1 when they differ |
| `bin/mc push <path>` | upload `server/<path>`; first copies the current remote version to `backups/<ts>/remote/<path>` |

Exit codes: 0 ok, 1 differences found (`diff` only), 2 error.

- `pull` replaces `server/<path>` with the remote copy. If the local copy holds edits that were never pushed, it moves them to `backups/<ts>/local/<path>` first and says so.
- `push` refuses when the remote listing (size and modtime, 1-second precision) changed since the last `pull` of that same path. Pull again, then reapply the edits from `backups/<ts>/local/`. Listings are kept per path: after pushing `plugins/X/a.yml`, a push of `plugins/X` is refused until `plugins/X` is pulled again.
- `push` copies only: files deleted locally are not deleted remotely.
- `push` writes over the remote file in place, because PebbleHost's SFTP refuses the rename of a `.partial` upload. Run the plugin's reload only after `push` reports success. An upload that fails midway can leave the remote file truncated. To restore it: `bin/mc pull <path>` (your edits move to `backups/<ts2>/local/<path>`), copy the `backups/<ts>/remote/<path>` that the error names over `server/<path>`, `bin/mc push <path>`, then copy your edits back from `backups/<ts2>/local/<path>` and push again.
- `pull`, `diff` and `push` on the server root need `--all`; don't use it without the user asking.
- While the server runs, plugins rewrite their data files at any time. Push config files, not whole data folders.

`server/`, `backups/` and `.mc/` are git-ignored: server files can hold plugin database passwords and must not be committed to this public repo. Run `make hooks` once per clone; it covers every worktree. The pre-commit, pre-merge-commit and pre-push hooks run `bin/path-guard`, which refuses (exit 2) any path outside the public allowlist, any symlink, and any copy of a file under `server/`, `backups/` or `.mc/`. Never bypass it with `--no-verify`. If something leaks anyway, follow `docs/leak-response.md`.

### From a git worktree

Background sessions may edit files only inside their worktree. Run the worktree's own `bin/mc`; no override is needed:

- `.env` comes from the main checkout when the worktree has none (`MC_ENV_FILE` still wins).
- `backups/` is the main checkout's, so backups survive `git worktree remove`. Messages print its absolute path.
- `server/` and `.mc/` are the worktree's own: pull fresh into the worktree, edit there, and push from there. They are deleted with the worktree.

## `bin/dev`: local dev server

`bin/dev up` builds `mc-dev:<project>-<hash>` from the committed `server/` and boots it in Docker with no network access. `bin/dev restart` keeps server state, `bin/dev rebuild` boots a new commit on a fresh volume, `bin/dev reset` re-applies `--fixtures` dirs, `bin/dev boot-report` summarises the boot, `bin/dev join` lets a Minecraft client connect on `127.0.0.1:25565`, `bin/dev console <command...>` runs a server command over RCON and prints its reply (for example `bin/dev console list`; exit 2 with the reason when the pod isn't up; it never prompts), and `bin/dev down` removes the pod. `up` and `rebuild` refuse uncommitted `server/` changes (exit 2); commit first. An untracked `server/` (the live copy pulled here) boots from a plain copy: `bin/dev up --jar purpur.jar --heap 6G`, then `bin/dev boot-report` compares it with the live `logs/latest.log`. Its output quotes server log lines, which may include player names, UUIDs and IPs: never paste it into a PR, issue or commit. The dev server generates a fresh world when `world*/` was not pulled. Dev images and `.dev/` hold the server's configs and secrets: never push or share them; `bin/dev down --all` removes the images. `console` and `join` mark the pod's volume explored.

## `bin/check`: recorded check runs

A check is a committed directory `checks/<id>/` with `profile.json` and `*.test.ts` files run by `node --test`. `profile.json` holds `kind` (`"e2e"` or `"bare-text"`) and, for e2e, optionally `fixtures` (directories in the check laid over the server on a volume's first boot; `bin/check run --fresh` boots with them), `data` (fixture paths that are plugin data; `*.db` always are), `needs` (`"console"`, `"bot"`), `restart` (the check calls `dev.restart()` or `dev.reset()`, which throw otherwise) and `exclusive` (a pod of its own). e2e checks import `dev` from `#harness/dev` (`dev.console(cmd)`, `dev.logSince(t)`, `dev.file(path)`, `dev.sqlite(path, sql, ...params)`); bare-text checks import only `test` and `bareText(file, path, literal)` from `#harness/unit`, which reads the file as committed, and the directory holds nothing but `profile.json` and `*.test.ts`. `bin/check run` resolves `#harness/*` itself and runs checks with a minimal env. `bin/check run <id>` runs one against the pod (e2e) or the committed `server/` (bare-text) and appends a record to `.verify/runs/issue-N.jsonl` (N from the branch `issue/N` or `--issue N`). The record carries the commit and hashes the running container was built from, not HEAD, so a fix counts only after `bin/dev rebuild`. `bin/check run <id> --fresh` rebuilds HEAD on a new volume first; only a red on such a volume will count, and no run on a volume touched by `bin/dev console` or `join` counts (the marker is inside the volume). `bin/dev up` and `rebuild` also refuse uncommitted harness image or relay changes. Commit `.verify/runs/`: the records are evidence. Exit 0 passed, 1 failed (recorded), 2 refused (nothing recorded): an uncommitted check, a file without tests, no pod.

The e2e loop: `bin/check run <id> --fresh` (red), commit the fix under `server/`, `bin/dev rebuild`, `bin/check run <id>` (green), commit `.verify/runs/`, then `bin/check gate <id>`. The gate exits 2 with each rule that failed unless a red and a later green of the same committed check for issue N hold rules G1-G10: the red is older than the green, the green booted a strict descendant commit that changed `server/`, nothing under `server/` or in the check changed after the green, both images were built from their commits with the same harness, check code and fixtures, the red ran on a `--fresh` volume, each was the first `bin/check run` on its volume (so no other check, and no `bin/dev console` or `join`, touched it first), HEAD descends from the green, and both record lines are committed unchanged. A bare-text check must also be nothing but `test(name, () => bareText(file, path, literal))` with a literal free of placeholders, color codes and tags, and the fix must touch every file it reads. The gate then re-runs the green on the running pod (it never boots one: `bin/dev rebuild` first, and the volume must not be explored) and records that confirm run, which must be the next run on the green's volume or the first on a new one; commit it too, since `postmortem` and `runbook` refuse an uncommitted confirm. The latest confirm run of the green decides. Only after a confirmed pass do `bin/check postmortem <id>` and `bin/check runbook <id>` write `docs/postmortems/` and `docs/runbooks/` from `templates/`; fill in their `<!-- -->` sections. G4 only sees that `server/` changed, not whether the change fixes anything: the postmortem's "Fix diff review" must justify every hunk of the diff. Rebuild before each green and before each gate: a red, a green and a confirm each count only as the first (or, for the confirm, the next) `bin/check run` on their volume, and the gate refuses without running when the pod's volume would not qualify.

The bare-text loop needs no pod and no `--fresh`: `bin/check run <id>` (red), commit the fix under `server/` (it must touch every file the check reads), `bin/check run <id>` (green), commit `.verify/runs/`, `bin/check gate <id>` (its confirm re-runs the check), commit the confirm record, then `postmortem` and `runbook`.

`bin/check suite` runs every committed check from a clean checkout and records nothing: bare-text checks first, then one pod (`suite0`, `suite1`, ...) per distinct merged fixture set with all its e2e checks. Checks share a pod only when their merged fixtures hash the same; checks with different fixtures get separate pods, and conflicting paths are refused within one check's own `fixtures` list (this replaces the plan's single merged profile with conflicts refused across checks). Between two checks on a pod it applies the fixtures again: with `data`, a restart that copies `/fixtures` over `/server` before the server starts; without, a copy of `/fixtures` over the running server, which neither deletes files a check created nor resets plugin state held in memory, so declare `data` for any plugin with state. `restart` checks run last on their pod; `exclusive` ones get their own. Each pod is torn down after its checks, pass or fail. The suite runs in a child process: on SIGINT or SIGTERM the parent kills it, removes every suite pod by label, and exits 130 or 143. If the parent itself was killed (SIGKILL), the next `bin/check suite` and `bin/dev down --all` stop the orphaned child (its group is in `.dev/suite.pid`, checked against `/proc` before any kill), and every `bin/check suite` first removes leftover suite pods. A check that can't run (a bad profile, conflicting fixtures, no tests) is reported `REFUSED` and the rest still run. It prints PASS/FAIL per check and a timings table (image cache hit, each boot, each check, each teardown, each refusal), writes `.dev/runs/<ts>/timings.json`, and prints `OVER BUDGET by Ns` past `checks/budget.json` (`{"seconds": N}`). Exit 0 all passed, 1 any check failed or was refused, 2 the suite itself was refused (dirty tree, no checks), 130/143 stopped by a signal.

## Taking a task

1. Locate: `bin/mc ls` from the root down (`plugins/`, the plugin's folder). Common places: `server.properties`, `bukkit.yml`, `spigot.yml`, `config/paper-*.yml`, `plugins/<Plugin>/config.yml` and the plugin's data folders, `logs/latest.log` for errors.
2. Pull only what the task needs. Don't pull `world*/` or `plugins/*.jar` unless asked: they are large. Before pulling a file that may be large, check its size with `bin/mc ls -l <dir>`.
3. Diagnose from the files and `logs/latest.log`. For plugin config questions, check the plugin's own documentation for the version in use (the version is in the jar name or the log's startup lines).
4. Edit under `server/`, then show the user `bin/mc diff <path>` and wait for their OK.
5. `bin/mc push <path>`, and tell the user what to run to apply it: the plugin's reload command, or a restart from the panel.

## Tests

Run `npm ci` once first. `make test-unit` (stubbed rclone, path-guard hooks in temp repos and `node --test test/ts/`, about a second), `make test-integration` (one shared `atmoz/sftp` Docker container for the whole run), `make test-dev` (`bin/dev` against vanilla Purpur in Docker, about a minute; downloads Purpur once), `make lint` (shellcheck and `tsc --noEmit`), and `make test-live` for a read-only `ls` against the real server.

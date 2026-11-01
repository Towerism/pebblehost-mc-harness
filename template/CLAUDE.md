# Private server repo

This private repo holds one Minecraft server's files, hosted on PebbleHost. It pushes only to its Gitea. The harness that works on it is the submodule `harness/`, pinned to a tag. Its `CLAUDE.md` and `AGENTS.md` describe the tools; this file covers the loop.

## Credentials: `.env`

`.env` holds the SFTP sign-in. Never read, print, grep or source it. `bin/mc`, `bin/dev` and `bin/check` pass it to `harness/bin/mc`, which reads it itself. If a variable is missing, ask the user to fix `.env`; the variable names are in `harness/.env.example`.

## Layout

- `server/` on `main` mirrors live. Only `bin/dev sync` writes it. It commits `live drift: <n> files`.
- `sync-rules`: `skip` paths are never transferred or committed, `data` paths are pulled only by `bin/dev seed N --with-data` and never committed, and `review` entries are proposals from `bin/dev inventory`. Promote each review entry to `skip` or `data`, or delete it.
- `checks/<n>-<slug>/`: one check per issue (`profile.json`, `*.test.ts`, fixtures), importing only `#harness/dev`, `#harness/bot` and `#harness/unit`.
- `.verify/runs/issue-N.jsonl`: the run records the gate reads. Commit them.
- `docs/postmortems/`, `docs/runbooks/`: written by `bin/check` after the gate.
- `.dev/`: pods' scratch, the `main` worktree of sync, seeds, runbook homes and journals. Not committed; it holds live files.

## Direct `bin/mc`

Only `bin/mc ls [-l] [-R]` and `bin/mc diff` are for direct use. `bin/mc pull` outside `.dev/` and `bin/mc push` outside `bin/check runbook push` are refused.

## Taking an issue N

1. `bin/dev seed N [--with-data PATH...]`: syncs live into `main`, puts the repo on `issue/N` (reused if it exists), pulls only the data the check needs into `.dev/seed-N`, and boots a fresh pod. Ask the user before pulling data or worlds.
2. Diagnose from the pod: `bin/dev console <cmd>`, `bin/dev logs`, `bin/dev boot-report`, the files under `server/`. For plugin config questions, read the plugin's own documentation for the installed version.
3. Write `checks/N-<slug>/` and commit it. `bin/check run N-<slug> --fresh` must fail: that is the red.
4. Fix under `server/` and commit the fix. `bin/dev rebuild`, then `bin/check run N-<slug>`: the green. A `restart` alone never counts.
5. `bin/dev rebuild`, then `bin/check gate N-<slug>`. Commit `.verify/runs/issue-N.jsonl`.
6. `bin/check postmortem N-<slug>` and `bin/check runbook N-<slug>`. Fill in the runbook's apply step and commit both.
7. `bin/check suite`: every check still passes.
8. Live: `bin/check runbook push N --plan` prints the files and their diffs. Show it to the user and wait for their OK. Then run `bin/check runbook push N`. It refuses if `main` or live changed those files since `issue/N` was cut; in that case run `bin/dev sync`, merge `main` into `issue/N`, and go back to step 4. If a push fails midway, `bin/check runbook rollback N` prints the restore commands; run them only after the user's OK.
9. Tell the user the apply step (the plugin's reload command, or a restart from the panel). After they confirm, run `bin/check run N-<slug> --target live`, which is read-only, and commit its record.
10. Push `issue/N` to Gitea and open the PR. Don't merge without the user.

## Setup and tests

`make setup` once after a clone. It initialises the submodule, runs `npm ci` and installs both hooks. `make test` refuses to run until both hooks are installed, then runs `bin/check suite`. To bump the harness, check out a new tag in `harness/`, run `make test`, and commit the submodule.

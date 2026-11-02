# src/dev

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
`bin/dev`: builds the dev image from the server tree, boots it as an isolated offline pod in Docker (server container, relay container, volume, internal network), and reports on the boot. `cli.ts` is the entry point that `bin/dev` runs; it also hosts the `sync`, `seed` and `inventory` verbs that call into `../sync/`.

## Key Files
| File | Description |
|------|-------------|
| `cli.ts` | `bin/dev` entry: argument parsing (`parse`), the command switch, `boot` (build, merge fixtures, create the pod, wait for "Done", prune images), `podFile` (command-line options win over the pod's saved ones; `--fixtures` replaces the saved sqlite fixtures too). Throws `DevError`; the top level prints `dev: <msg>` and exits 2 |
| `image.ts` | Build context, identity hashes, labels and the images. `HARNESS_INPUTS` (`docker/server.Dockerfile`, `docker/entrypoint.sh`, `src/dev/overrides.ts`) and `RELAY_INPUTS` (relay Dockerfile, `package.json`, lockfile, `daemon.ts`, `client.ts`, `rcon.ts`, `bots.ts`); `CHECK_DIRS`; `source` (git when `server/` is tracked, else a plain directory), `identity`, `treeHash`, `dirHash`, `treeDiff`, `harnessHash`, `toolHash`, `dirtyServer`, `dirtyHarness`, `chooseJar`, `buildContext`, `build` (`mc-dev:<project>-<imageHash>`), `buildRelay` (`mc-relay:<project>-<hash of RELAY_INPUTS>`), `verifyOverrides`, `pruneImages`, `labels`, `privateDir`, `git` |
| `pod.ts` | The pod: names (`names`, `podOf`), `createPod`, `createJoin`, `removePod`, `mergeFixtures` (fixtures and `sqlite` databases), `relayRequest`, `restartServer`, the explored marker (`markExplored`, `isExplored`), the run log (`logRun`, `runPosition`), `killOrphanSuite`, boot wait (`waitDone`, `bootTimeout`, `readBoots`, `recordBoot`) and boot report (`parseBootReport`, `formatBootReport`), `EGRESS_SINKS`, `OFFLINE_NOISE`, `readPodFile` |
| `overrides.ts` | Dev-only config baked into the image's last layer: `online-mode=false`, `server-port=25565`, the Votifier listener off (`port: -1`), Bukkit's connection throttle off (`settings.connection-throttle: -1`, bots join back to back from one address), and every update check and metrics flag found in the live copy, each by its real key (`OVERRIDES`). `setProperty` and `setYaml` edit one line; a missing file or key is a no-op with a note, never an error |
| `docker.ts` | CLI wrapper (`docker`, `must`), `DevError` and `fail`. `MC_DOCKER` swaps the binary (unit tests point it at a fake that records argv). The `env` option passes values docker must read from its environment, out of argv |

## For AI Agents

### Working In This Directory
- Never read, print or source `.env`; this directory never needs it (`bin/dev sync` hands it to `bin/mc` by path).
- A dev image is built only from committed `server/` (`git archive`, label `mc-harness.source=archive`); `up` and `rebuild` refuse uncommitted `server/` changes (`refuseDirty`). An untracked `server/` builds from a plain copy instead (`source=dir`, empty `commit`, `tree=dir:<sha256>`); only `source=archive` images can count for the red/green gate. `rebuild` builds first and replaces the old pod only after the build succeeded.
- Identity labels (`mc-harness.source`, `commit`, `tree`, `harness`, `image`) are read from the container, never from HEAD: `restart` keeps the booted commit, only `rebuild` changes it. The container itself carries `mc-harness.commit` and `source` of the checkout that booted it (`Spec`), overriding the image's: a cached image names whichever commit first built that tree. Each new volume gets a `mc-harness.generation` id (volume and container label) and `mc-harness.fresh=true` only from `bin/check run --fresh`.
- A change to a file in `HARNESS_INPUTS` changes every image hash (`harnessHash`). `up`, `rebuild` and `bin/check run` refuse uncommitted `HARNESS_INPUTS`, `RELAY_INPUTS` or `CHECK_DIRS` code (`dirtyHarness`), so a record's `harnessHash` and `toolHash` (the tracked check and gate code; ignored files don't count) always name committed code. Commit harness changes before running the dev tier or the check tests. Adding a file to the relay image means adding it to `RELAY_INPUTS` (`buildRelay` maps paths to the context by prefix).
- Dev images and `.dev/` contain server configs and their secrets (plugin database passwords, tokens). Never push an `mc-dev` image or copy `.dev/` anywhere. `.dev/` is owner-only (0700 through `privateDir`; `pod.json`, `boots.json` and saved logs 0600); the merged fixtures stay readable because the container's uid 1000 reads them. After each boot `boot` calls `pruneImages`, removing the checkout's `mc-dev` and `mc-relay` images that no container uses; a plain `down` keeps the current image as the build cache, `down --all` removes the images too.
- `server/` may hold several root jars (the host picks one outside the files): `up --jar NAME` picks one, else the only root jar is used, else `up` refuses (`chooseJar`). `--jar` and `--heap` are saved in `pod.json` for `rebuild`. The jar is passed at run time (`MC_JAR`), so it is not part of the image hash. `MC_JAVA_OPTS` overrides the heap flags; `MC_DEV_MEMORY` adds `--memory`.
- Each successful boot's wall time goes to `.dev/pods/<pod>/boots.json` (last 5); the default boot timeout is 3x their median (at least 120s; 600s before any). `boot-report` compares the dev boot with `server/logs/latest.log` (the live boot) when it exists: `N/M` plugins enabled, and each one missing with its error line. Only `Enabling <Name> v<digit>` lines count (`parseBootReport`), and a plugin that logs one and then "Error occurred while enabling" counts as not enabled; each missing plugin shows its first `Caused by:` line. Known offline noise (auth key fetches, update checks, SLF4J) is counted apart from real errors (`OFFLINE_NOISE`). Its output quotes server log lines, which may include player names, UUIDs and IPs: never paste it into a PR, issue or commit.
- Override files keep their line endings (`cr`) and get an mtime 2s past their `cfg/` copy, because the classic builder drops a later-layer file whose size and mtime second match; after each build `verifyOverrides` checks every override byte-for-byte in the image, and a mismatch removes the image and fails (exit 2). A new override uses the key as it appears in the live copy; update the date in the comment above `OVERRIDES`.
- Explored marker: `bin/dev console`, `bot` (except `list`) and `join` touch `/server/.mc-harness-explored` inside the volume (`markExplored`, `docker exec`), and `bin/check run` tests for it in the running container (`isExplored`). It lives with the volume on purpose: it survives `restart`, `reset` and a deleted `.dev/`, and only a new volume (`rebuild`, `--fresh`) starts without it. Docker labels can't be changed after create, so it can't be a label. Checks' own `dev.console` calls don't mark it.
- Run log: every e2e `bin/check run` appends `<time> issue-N <id> <nonce>` to `/server/.mc-harness-runs` in the volume in one `O_APPEND` write (`logRun`). After the tests, `runPosition` re-reads the log: the position of the nonce line is the run's `runIndex`, and lines after it (or a missing line) mean another run touched the volume meanwhile. The gate (in `../gate/`) counts a red or green only as the first, non-concurrent run on its volume.
- Pods have no published port and no egress: an internal, IPv4-only network without a gateway (`--internal`, `gateway_mode_ipv4=isolated`); known update and metrics hosts are also `--add-host`ed to 127.0.0.1 so calls fail at once (`EGRESS_SINKS`). The server runs as uid 1000 with all capabilities dropped, `no-new-privileges` and `--pids-limit 4096`. The RCON password reaches docker through its environment, never argv (`must`'s `env`).
- Each pod also runs a relay container (`mc-<project>-<pod>-relay`) on the pod network only: `--init` (Docker's bundled tini as PID 1), uid 1000, read-only root with a tmpfs `/run` (and `/tmp`), all capabilities dropped, `no-new-privileges`. Its image `mc-relay:<project>-<hash of RELAY_INPUTS>` is rebuilt when a relay file changes and pruned with the `mc-dev` ones. `restart` and `reset` leave the relay running (it reconnects on the next command); `up` and `rebuild` recreate it; `down` removes it by label. `relayRequest` fails with a hint when the relay is not running. New relay verbs go into the daemon's `op` table (see `../relay/AGENTS.md`).
- Only `bin/dev join` publishes `127.0.0.1:<port>`, through a socat proxy (`SOCAT_IMAGE`, pinned by digest) on its own labelled network, read-only and as nobody.
- `reset` removes `/server/.mc-harness-seeded` so `/fixtures` is applied again on the next boot (see `../../docker/AGENTS.md`). `mergeFixtures` builds in a sibling `.next` directory and swaps it in, so a failed build leaves a running pod's `/fixtures` as it was; a path that two sources fill with different bytes is refused. `sqlite` fixtures run under `enableDefensive` and an authorizer that denies ATTACH/DETACH.
- `bin/dev down --all` also stops an orphaned `bin/check suite` child (`killOrphanSuite`: it reads `.dev/suite.pid` and kills the group only when `/proc/<pid>/environ` shows `MC_SUITE_CHILD=1` and this `MC_HOME`).
- Every harness git call sets `GIT_NO_REPLACE_OBJECTS=1` (`git` in `image.ts`); the image build re-hashes the extracted `git archive` against `<commit>:server` (`treeDiff`) and refuses on export-ignore or export-subst. Symlinks under `server/` are refused.

### Testing Requirements
`make test` (lint, unit, integration), plus `make test-dev` for any change here: it runs `bin/dev` against vanilla Purpur in Docker (about a minute; needs Docker and, once, network for `test/dev/prime`). Unit coverage is `test/ts/dev.test.ts` (imports `docker.ts`, `image.ts`, `overrides.ts`, `pod.ts`, `cli.ts`'s `podFile`, with a fake docker via `MC_DOCKER`; `test/ts/project.ts` is its helper) and `test/dev/dev.bats` (end to end). `test/dev/seed.bats` covers `seed`, `test/dev/suite.bats` and `test/dev/verify.bats` the pod behaviour the check suite and gate depend on, and `test/ts/suite.test.ts` and `test/ts/suite-signal.test.ts` the suite pod teardown. A new override needs a case in `test/ts/dev.test.ts`.

### Common Patterns
- Every refusal is `fail(msg)` (throws `DevError`); the CLI prints it and exits 2. It never prompts.
- Docker access takes a `Docker` function argument (`d`), so tests inject a fake.
- Every container, volume and network carries `mc-harness.project` and `mc-harness.pod` labels; `removePod` and `pruneImages` work by label. The project id is a hash of the real path of `MC_HOME`.

## Dependencies

### Internal
- `../sync/sync.ts` (`syncLive`, `seedData`, `issueBranch`, `inventory`, `refuseSkipped`); `../sync/` also imports `fail`, `git`, `HARNESS_ROOT` and `privateDir` from here
- `../../docker/` (Dockerfiles and entrypoint, copied into the build contexts), `../relay/` (the files baked into the relay image)
- Used by `../check/` and `../gate/` (identity hashes, `relayRequest`, run log, explored marker)

### External
- Docker CLI; images `eclipse-temurin:25-jre` and `alpine/socat` (pinned by digest)
- `git`, `tar`; Node 24.12+ (`node:sqlite` `enableDefensive` and `setAuthorizer`)

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

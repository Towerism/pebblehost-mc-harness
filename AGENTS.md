# pebblehost-mc-harness

**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
A harness that lets Claude manage the files of one Minecraft server (Purpur) hosted on PebbleHost. Server files are reached over SFTP through `bin/mc`, a bash wrapper around rclone. Credentials come from a git-ignored `.env`. The task loop and the `.env` rules are in `CLAUDE.md`; read it first.

## Key Files
| File | Description |
|------|-------------|
| `CLAUDE.md` | Operating guide: `.env` contract, `bin/mc` commands, the pull → edit → diff → user OK → push loop |
| `.env.example` | Template for `.env` (`PEBBLE_SFTP_HOST`, `PEBBLE_SFTP_PORT`, `PEBBLE_SFTP_USER`, `PEBBLE_PANEL_PASSWORD`, `PEBBLE_SERVER_NAME`) |
| `Makefile` | `lint`, `test-unit`, `test-integration`, `test-dev`, `test-live`, `test`, `hooks` |
| `package.json`, `tsconfig.json` | Node 24 runs the TypeScript in `src/` directly (type stripping); `tsc --noEmit` only type-checks |
| `.gitignore` | Keeps `.env`, `server/`, `backups/`, `.mc/`, `.omc/`, `.dev/` and `node_modules/` out of this public repo |
| `.claude/settings.json` | Denies Claude reading `.env` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `bin/` | The `mc`, `dev` and `check` commands and the `path-guard` shim (see `bin/AGENTS.md`) |
| `src/check/` | `bin/check`: `run.ts` (runs `checks/<id>/*.test.ts` with `node --test`, refuses uncommitted checks and files without tests), `record.ts` (the run record and `.verify/runs/issue-N.jsonl`), `profile.ts` (`profile.json`: kind, fixtures, data, needs, restart, exclusive), `suite.ts` (`bin/check suite`: `planSuite` groups checks by fixture profile and picks the reset between checks, `runSuite` boots, runs and tears down, refusing a check that can't run on its own; `teardownSuitePods` removes every `suite<N>` pod by label; `bin/check suite` runs `runSuite` in a detached child (`MC_SUITE_CHILD=1`) and, on SIGINT/SIGTERM, kills its process group, sweeps the suite pods until none is left and exits 130/143; at start it kills an orphaned child recorded in `.dev/suite.pid` (`killOrphanSuite` in `pod.ts`, only when `/proc/<pid>/environ` shows `MC_SUITE_CHILD=1` and this `MC_HOME`; `bin/dev down --all` does the same) and removes leftover suite pods), `timings.ts` (`timings.json`, the table, `checks/budget.json`), `dev.ts`, `bot.ts` and `unit.ts` (the check APIs, imported as `#harness/dev`, `#harness/bot` and `#harness/unit`), `loader.ts` (the `--import` hook that pins those two to this harness, whatever any `package.json` maps, and lets a check's files import only files in their own `checks/<id>/` (`MC_CHECK_DIR`), `node:` built-ins and packages; no module may load a `data:`, `http:` or other non-file URL; a refused import makes `bin/check run` exit 2 without a record; committed symlinks in a check are refused too. This confinement is hygiene against shared helpers changing between red and green, not a sandbox: an e2e check can still use `fs` or `child_process`, so reviewers read the check) |
| `src/gate/` | `gate.ts` (rules G1-G10 over the run records and a `GateRepo`, pure for the tests, and `confirmOf`: the latest confirm run of a green decides), `bareText.ts` (the G8 static check: a tokenizer and the one allowed shape, literal rules), `docs.ts` (the postmortem and runbook from `templates/`, only after a confirmed gate pass) |
| `templates/` | `postmortem.md` and `runbook.md`, rendered by `bin/check postmortem` and `runbook` with `{{field}}` values |
| `src/relay/` | The pod's relay container: `bots.ts` (mineflayer sessions by name: `bot.join` resolves on spawn, `bot.chat`, `bot.waitMessage` reads received lines from a cursor so a reply between two calls isn't lost, `bot.quit`, `bot.quitAll`, `bot.list`; the factory is injected; sessions live only in the daemon: a relay restart or recreate (`up`, `rebuild`) drops them, a server restart disconnects them, and they must join again; the client's timeout is a minute past the request's `timeoutMs`, and the daemon's idle timeout covers only reading the request, so long waits aren't cut), `mineflayer.d.ts` (the types used; mineflayer is installed only in the relay image), `daemon.ts` (PID 1 behind tini; one JSON request, one JSON reply per connection on `/run/relay.sock`, dispatched by `op`; owns the pod's RCON connection and reconnects after a server restart), `client.ts` (stdin request, stdout reply, exit 0/2; run by `bin/dev console` through `docker exec -i`), `rcon.ts` (RCON codec and client: auth, multi-packet replies via an end-marker packet, timeouts) |
| `src/dev/` | `bin/dev`: `image.ts` (build context, identity hashes, labels, the `mc-relay:<project>-<hash>` image), `pod.ts` (network, volume, container, fixtures, boot wait and report), `overrides.ts` (dev-only config baked into the image: `online-mode=false`, the Votifier listener off, Bukkit's connection throttle off (bots join back to back from one address), and every update check and metrics flag found in the live copy, each by its real key; a missing file or key is a no-op with a note), `docker.ts` (CLI wrapper; `MC_DOCKER` swaps the binary) |
| `docker/` | `server.Dockerfile` (Temurin 25, pinned by digest; jar layer, config layer, overrides layer), `entrypoint.sh` (fixtures on first boot, RCON password, `exec java`) and `relay.Dockerfile` (Node 24 slim, pinned by digest; a deps stage runs `npm ci` on `docker/relay/package.json` and its lockfile, mineflayer 4.39.0 for 26.1 / protocol 775, so the first relay build needs the npm registry; then the `src/relay/` files) |
| `src/guard/` | Path guard: `paths.ts` holds the allowlist, the case-insensitive denylist and the 512 KB cap; `cli.ts` checks staged files or commits, and also refuses symlinks and copies of local server files |
| `hooks/` | `pre-commit`, `pre-merge-commit` and `pre-push`, run through the stubs `make hooks` installs |
| `docs/` | `leak-response.md`: what to do when a server file or secret reaches this repo |
| `.github/workflows/` | CI: `make lint test-unit` and the path guard over the PR's commits |
| `test/` | Unit, integration and live test suites (see `test/AGENTS.md`) |

Created at runtime and git-ignored: `server/` (local mirror of pulled server files), `.dev/pods/<pod>/` (`pod.json`, the merged fixtures, boot logs saved on failure), `backups/<ts>/{remote,local}/` (copies saved before a push or a re-pull), `.mc/` (per-path remote listings and local checksums).

## For AI Agents

### Working In This Directory
- Never read, print, grep or source `.env`; `bin/mc` loads it.
- Never commit anything from `server/` or `backups/`: server files can hold plugin database passwords and this repo is public.
- Run `make hooks` in each new clone. `bin/install-hooks` writes stubs to the repo's shared hooks directory (`git rev-parse --git-common-dir`), so every worktree runs its own checkout's `hooks/<name>`, and a checkout without `hooks/` refuses the commit or push. It unsets `core.hooksPath` if that was `hooks`. The hooks run `bin/path-guard`, which exits 2 and lists every refused path; never bypass it with `--no-verify`.
- Cherry-pick and rebase run no commit hook: `pre-push` (every new commit since the remote tip, or since `origin/main` for a new branch) and CI are the gate for those.
- A new top-level directory or root file must be added to the allowlist in `src/guard/paths.ts`, with a test.
- Changes to server files go through `bin/mc` and need the user's OK on the `bin/mc diff` before `bin/mc push`.
- A dev image is built only from committed `server/` (`git archive`, label `mc-harness.source=archive`); `bin/dev up` and `rebuild` refuse uncommitted changes. An untracked `server/` builds from a plain copy instead (`source=dir`, empty `commit`, `tree=dir:<sha256>`); only `source=archive` images can count for the red/green gate. Identity labels (`mc-harness.source`, `commit`, `tree`, `harness`, `image`) are read from the container, never from HEAD: `restart` keeps the booted commit, only `rebuild` changes it. `rebuild` builds first and replaces the old pod only after the build succeeded.
- Dev images and `.dev/` contain server configs and their secrets (plugin database passwords, tokens). Never push an `mc-dev` image or copy `.dev/` anywhere. `.dev/` is owner-only (0700; `pod.json` and saved logs 0600); the merged fixtures stay readable because the container's uid 1000 reads them. After each boot `bin/dev` removes the checkout's `mc-dev` images that no container uses; a plain `down` keeps the current image as the build cache, `down --all` removes the images too. A change to a file in `HARNESS_INPUTS` (`src/dev/image.ts`) changes every image hash.
- `server/` may hold several root jars (the host picks one outside the files): `bin/dev up --jar NAME` picks one, else the only root jar is used, else `up` refuses. `--jar` and `--heap` are saved in `pod.json` for `rebuild`. The jar is passed at run time (`MC_JAR`), so it is not part of the image hash.
- Each successful boot's wall time goes to `.dev/pods/<pod>/boots.json`; the default boot timeout is 3x their median (600s before any). `boot-report` compares the dev boot with `server/logs/latest.log` (the live boot) when it exists: `N/M` plugins enabled, and each one missing with its error line. Only `Enabling <Name> v<digit>` lines count, and a plugin that logs one and then "Error occurred while enabling" counts as not enabled; each missing plugin shows its first `Caused by:` line. Known offline noise (auth key fetches, update checks, SLF4J) is counted apart from real errors (`OFFLINE_NOISE`). Its output quotes server log lines, which may include player names, UUIDs and IPs: never paste it into a PR, issue or commit.
- Override files keep their line endings and get an mtime 2s past their `cfg/` copy, because the classic builder drops a later-layer file whose size and mtime second match; after each build every override is checked byte-for-byte in the image, and a mismatch removes the image and fails (exit 2).
- Each new volume gets a `mc-harness.generation` id (volume and container label) and `mc-harness.fresh=true` only from `bin/check run --fresh`.
- Explored marker: `bin/dev console` and `join` touch `/server/.mc-harness-explored` inside the volume (`docker exec`), and `bin/check run` tests for it in the running container. It lives with the volume on purpose: it survives `restart`, `reset` and a deleted `.dev/`, and only a new volume (`rebuild`, `--fresh`) starts without it. Docker labels can't be changed after create, so it can't be a label. Checks' own `dev.console` calls don't mark it.
- Records read identity from the container labels. The container itself carries `mc-harness.commit` and `source` of the checkout that booted it, overriding the image's: a cached image names whichever commit first built that tree. A bare-text record reads a clean HEAD, and `bareText` reads files from that commit (`MC_COMMIT`), never the working tree.
- `up`, `rebuild` and `bin/check run` refuse uncommitted `HARNESS_INPUTS`, `RELAY_INPUTS` or `CHECK_DIRS` code (`dirtyHarness`), so a record's `harnessHash` and `toolHash` (the tracked check and gate code; ignored files don't count) always name committed code. Commit harness changes before running the dev tier or the check tests.
- Run log: every e2e `bin/check run` appends `<time> issue-N <id> <nonce>` to `/server/.mc-harness-runs` in the volume in one `O_APPEND` write. After the tests it re-reads the log: `runIndex` is the position of its nonce line, and `concurrent` is set when any line follows it (another run on the same volume meanwhile) or the line is gone. `explored` is checked before and after the run. The gate counts a red or green only as the first, non-concurrent run on its volume.
- `bin/check run` runs only the `*.test.ts` of the committed `checks/<id>` tree and refuses any untracked or ignored file in that directory. The image build re-hashes the extracted `git archive` and refuses when it isn't `<commit>:server` (export-ignore, export-subst); every harness git call sets `GIT_NO_REPLACE_OBJECTS=1`.
- `bin/check run` starts `node --test` with an allow-listed env (`KEEP_ENV` plus `MC_HOME`, `MC_POD`, `MC_TARGET`, `MC_COMMIT`): no `NODE_OPTIONS` or other `NODE_*` from the caller. `--import loader.ts` resolves `#harness/*`. A bare-text check directory may hold only `profile.json` and `*.test.ts`.
- `bin/check gate` reads the pod's run log before a confirm and refuses (nothing run, nothing recorded) unless the confirm would be run `green.runIndex + 1` on the green's volume or run 0 on a new one; a rejected confirm names the reason (`confirmCheck`). G9 also refuses a `concurrent` red or green.
- The gate picks the newest green with an earlier red that passes every rule; confirm records never stand in for a green, and `postmortem`/`runbook` look for the latest confirm record of the chosen green instead of keeping gate state.
- Pods have no published port and no egress (an internal, IPv4-only network without a gateway; known update and metrics hosts are also `--add-host`ed to 127.0.0.1 so calls fail at once, see `EGRESS_SINKS` in `src/dev/pod.ts`); the server runs as uid 1000 with all capabilities dropped, `no-new-privileges` and `--pids-limit 4096` (`MC_DEV_MEMORY` adds `--memory`). The RCON password reaches docker through its environment, never argv. Each pod also runs a relay container (`mc-<project>-<pod>-relay`) on the pod network only: `--init` (Docker's bundled tini as PID 1), uid 1000, read-only root with a tmpfs `/run`, all capabilities dropped, `no-new-privileges`; its image `mc-relay:<project>-<hash of RELAY_INPUTS>` is rebuilt when a relay file changes and pruned with the `mc-dev` ones. `restart` and `reset` leave the relay running (it reconnects on the next command); `up` and `rebuild` recreate it; `down` removes it by label. New relay verbs go into the daemon's `op` table (`consoleOps` is the pattern). Only `bin/dev join` publishes `127.0.0.1:<port>`, through a socat proxy on its own labelled network, read-only and as nobody.

### Testing Requirements
`npm ci` once, then `make test` (lint, unit, integration) before committing a change to `bin/`, `src/`, `hooks/` or `test/`, and `make test-dev` too for `src/dev/`, `docker/` or `test/dev/`. It needs Docker and, once, network for `test/dev/prime`. `make test-live` is read-only against the real server.

## Dependencies

### External
- `rclone`: SFTP transfers and listings
- `bats` (with GNU `parallel` for `--jobs`): test runner; `shellcheck`: lint
- Node 24 or later; `typescript` and `@types/node`, exact-pinned dev dependencies
- Docker with the `atmoz/sftp:alpine` image: integration tests
- Docker with `eclipse-temurin:25-jre` and `alpine/socat` (both pinned by digest): `bin/dev` and the dev tier. Without the buildx plugin, `docker build` uses the classic builder; both cache the jar layer.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

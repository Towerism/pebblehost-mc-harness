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
| `bin/` | The `mc` and `dev` commands and the `path-guard` shim (see `bin/AGENTS.md`) |
| `src/dev/` | `bin/dev`: `image.ts` (build context, identity hashes, labels), `pod.ts` (network, volume, container, fixtures, boot wait and report), `overrides.ts` (dev-only config baked into the image), `docker.ts` (CLI wrapper; `MC_DOCKER` swaps the binary) |
| `docker/` | `server.Dockerfile` (Temurin 25, pinned by digest; jar layer, config layer, overrides layer) and `entrypoint.sh` (fixtures on first boot, RCON password, `exec java`) |
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
- Pods have no published port and no egress (an internal, IPv4-only network without a gateway); the server runs as uid 1000 with all capabilities dropped, `no-new-privileges` and `--pids-limit 4096` (`MC_DEV_MEMORY` adds `--memory`). The RCON password reaches docker through its environment, never argv. Only `bin/dev join` publishes `127.0.0.1:<port>`, through a socat proxy on its own labelled network, read-only and as nobody.

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

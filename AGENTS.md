# pebblehost-mc-harness

**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
A harness that lets Claude manage the files of one Minecraft server (Purpur) hosted on PebbleHost. Server files are reached over SFTP through `bin/mc`, a bash wrapper around rclone. Credentials come from a git-ignored `.env`. The task loop and the `.env` rules are in `CLAUDE.md`; read it first. Terms (live, pod, check, red/green/confirm, explored, private repo) are defined in `GLOSSARY.md`.

## Key Files
| File | Description |
|------|-------------|
| `CLAUDE.md` | Operating guide: `.env` contract, `bin/mc` commands, the pull → edit → diff → user OK → push loop, `bin/dev` and `bin/check` |
| `GLOSSARY.md` | Project vocabulary and the docs' language (`documentLanguage`); wins on term conflicts |
| `.env.example` | Template for `.env` (`PEBBLE_SFTP_HOST`, `PEBBLE_SFTP_PORT`, `PEBBLE_SFTP_USER`, `PEBBLE_PANEL_PASSWORD`, `PEBBLE_SERVER_NAME`) |
| `Makefile` | `lint`, `test-unit`, `test-integration`, `test-dev`, `test-live`, `test`, `hooks` |
| `package.json`, `tsconfig.json` | Node 24 runs the TypeScript in `src/` directly (type stripping); `tsc --noEmit` only type-checks |
| `.gitignore` | Keeps `.env`, `server/`, `backups/`, `.mc/`, `.omc/` (except `.omc/skills/`), `.dev/` and `node_modules/` out of this public repo |
| `.claude/settings.json` | Denies Claude reading `.env` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `bin/` | The `mc`, `dev` and `check` commands, `install-hooks` and the `path-guard` shim (see `bin/AGENTS.md`) |
| `src/` | TypeScript behind `bin/dev`, `bin/check`, the path guard, the pod's relay and the sync (see `src/AGENTS.md`) |
| `docker/` | Server and relay images, the entrypoint (see `docker/AGENTS.md`) |
| `hooks/` | `pre-commit`, `pre-merge-commit`, `pre-push`, and the private repo's `private-pre-push` (see `hooks/AGENTS.md`) |
| `template/` | What a private server repo starts from (see `template/AGENTS.md`) |
| `templates/` | `postmortem.md`, `runbook.md` and the default `sync-rules` (see `templates/AGENTS.md`) |
| `test/` | Unit, integration, dev and live test suites (see `test/AGENTS.md`) |
| `docs/` | `leak-response.md`: what to do when a server file or secret reaches this repo |
| `.omc/skills/` | OMC project skills, one `<name>.md` each, the only committed part of `.omc/`: `harness-live-evidence.md` times an unmerged harness change against live through the private server repo before its PR merges |
| `.github/workflows/` | CI: `make lint test-unit` and the path guard over the PR's commits |

Created at runtime and git-ignored: `server/` (local mirror of pulled server files), `.dev/pods/<pod>/` (`pod.json`, the merged fixtures, boot logs saved on failure), `backups/<ts>/{remote,local}/` (copies saved before a push or a re-pull), `.mc/` (per-path remote listings and local checksums).

## For AI Agents

### Working In This Directory
- Never read, print, grep or source `.env`; `bin/mc` loads it.
- Never commit anything from `server/` or `backups/`: server files can hold plugin database passwords and this repo is public.
- Run `make hooks` in each new clone; never bypass the path guard with `--no-verify` (details in `hooks/AGENTS.md`).
- A new top-level directory or root file other than `*.md` must be added to the allowlist in `src/guard/paths.ts`, with a test (see `src/guard/AGENTS.md`).
- Changes to server files go through `bin/mc` and need the user's OK on the `bin/mc diff` before `bin/mc push`.
- Dev images and `.dev/` contain server configs and their secrets (plugin database passwords, tokens). Never push an `mc-dev` image or copy `.dev/` anywhere (see `src/dev/AGENTS.md`).
- Each module's invariants live in its own AGENTS.md; read the nearest one before editing a file.

### Testing Requirements
`npm ci` once, then `make test` (lint, unit, integration) before committing a change to `bin/`, `src/`, `hooks/` or `test/`, and `make test-dev` too for `src/dev/`, `docker/` or `test/dev/`. It needs Docker and, once, network for `test/dev/prime`. `make test-live` is read-only against the real server.

## Dependencies

### External
- `rclone`: SFTP transfers and listings
- `bats` (with GNU `parallel` for `--jobs`): test runner; `shellcheck`: lint
- Node 24.12 or later (node:sqlite's `enableDefensive`); `typescript` and `@types/node`, exact-pinned dev dependencies
- Docker with the `atmoz/sftp:alpine` image: integration tests
- Docker with `eclipse-temurin:25-jre` and `alpine/socat` (both pinned by digest): `bin/dev` and the dev tier. Without the buildx plugin, `docker build` uses the classic builder; both cache the jar layer.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

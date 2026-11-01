# pebblehost-mc-harness

**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
A harness that lets Claude manage the files of one Minecraft server (Purpur) hosted on PebbleHost. Server files are reached over SFTP through `bin/mc`, a bash wrapper around rclone. Credentials come from a git-ignored `.env`. The task loop and the `.env` rules are in `CLAUDE.md`; read it first.

## Key Files
| File | Description |
|------|-------------|
| `CLAUDE.md` | Operating guide: `.env` contract, `bin/mc` commands, the pull → edit → diff → user OK → push loop |
| `.env.example` | Template for `.env` (`PEBBLE_SFTP_HOST`, `PEBBLE_SFTP_PORT`, `PEBBLE_SFTP_USER`, `PEBBLE_PANEL_PASSWORD`, `PEBBLE_SERVER_NAME`) |
| `Makefile` | `lint`, `test-unit`, `test-integration`, `test-live`, `test` |
| `.gitignore` | Keeps `.env`, `server/`, `backups/`, `.mc/` and `.omc/` out of this public repo |
| `.claude/settings.json` | Denies Claude reading `.env` |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `bin/` | The `mc` command (see `bin/AGENTS.md`) |
| `test/` | Unit, integration and live test suites (see `test/AGENTS.md`) |

Created at runtime and git-ignored: `server/` (local mirror of pulled server files), `backups/<ts>/{remote,local}/` (copies saved before a push or a re-pull), `.mc/` (per-path remote listings and local checksums).

## For AI Agents

### Working In This Directory
- Never read, print, grep or source `.env`; `bin/mc` loads it.
- Never commit anything from `server/` or `backups/`: server files can hold plugin database passwords and this repo is public.
- Changes to server files go through `bin/mc` and need the user's OK on the `bin/mc diff` before `bin/mc push`.

### Testing Requirements
`make test` (lint, unit, integration) before committing a change to `bin/mc` or `test/`. `make test-live` is read-only against the real server.

## Dependencies

### External
- `rclone`: SFTP transfers and listings
- `bats`: test runner; `shellcheck`: lint
- Docker with the `atmoz/sftp:alpine` image: integration tests

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

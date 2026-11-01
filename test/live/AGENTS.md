# live

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
Opt-in, read-only smoke test against the real PebbleHost server, using the `.env` in `MC_HOME`.

## Key Files
| File | Description |
|------|-------------|
| `smoke.bats` | Skips unless `MC_LIVE=1`; runs `mc ls .` and expects `server.properties` |

## For AI Agents

### Working In This Directory
Tests here must stay read-only (`ls`, or `pull` into a temp `MC_HOME`); never `push` to the real server from a test. Run with `make test-live`, adding `MC_HOME=<dir with .env>` when running from a worktree.

## Manual Notes

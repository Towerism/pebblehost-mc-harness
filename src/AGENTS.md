# src

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The harness's TypeScript. Node 24 runs it directly (type stripping); `tsc --noEmit` only type-checks. The `bin/` shims (`bin/check`, `bin/dev`, `bin/path-guard`) call into these directories. Each subdirectory is one tool; they share helpers through relative imports (see the Dependencies in each).

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `check/` | `bin/check`: runs recorded checks, the suite, the read-only live target, and the `#harness/*` APIs checks import (see `check/AGENTS.md`) |
| `dev/` | `bin/dev`: the local dev server pod, image and overrides (see `dev/AGENTS.md`) |
| `gate/` | The red/green gate rules G1-G10, the G8 bare-text check, and the postmortem and runbook renderer (see `gate/AGENTS.md`) |
| `guard/` | The path guard behind `bin/path-guard` and the git hooks (see `guard/AGENTS.md`) |
| `relay/` | The pod's relay container: RCON and headless bots (see `relay/AGENTS.md`) |
| `sync/` | `sync-rules`, `bin/dev sync`/`seed`/`inventory`, and `runbook push` (see `sync/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Files use `.ts` extensions in relative imports; there is no build step.
- A new top-level directory or root file in the repo must be added to the allowlist in `guard/paths.ts`, with a test.
- Changes under `check/`, `gate/` or `dev/image.ts`'s input lists change the `harnessHash`/`toolHash` that run records carry; commit them before running checks (`bin/dev up`, `rebuild` and `bin/check run` refuse uncommitted harness code).

### Testing Requirements
`make test` before committing a change here; add `make test-dev` for `dev/`. Unit tests are in `test/ts/` (see `../test/AGENTS.md`).

## Dependencies

### External
- Node 24.12 or later (`node:sqlite`, `node:test`, `node:module` hooks); `typescript` and `@types/node` for `tsc --noEmit`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

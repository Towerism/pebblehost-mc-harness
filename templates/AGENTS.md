# templates

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
Source texts that `bin/check` and the private repo's `make setup` copy or render: the postmortem and runbook written after a confirmed gate pass, and the default `sync-rules`. Not to be confused with `template/` (singular), the starting tree of a private server repo.

## Key Files
| File | Description |
|------|-------------|
| `postmortem.md` | Rendered by `bin/check postmortem <id>` into `docs/postmortems/`. Fields: `{{title}}`, `{{issue}}`, `{{date}}`, `{{check}}`, `{{redCommit}}`, `{{greenCommit}}`, `{{serverDiff}}`, `{{serverPatch}}` and others. Sections: Cause, Evidence, Fix, Fix diff review (must justify every hunk of the diff: G4 only sees that `server/` changed), Wrong turns. `<!-- -->` comments mark the parts a person fills in |
| `runbook.md` | Rendered by `bin/check runbook <id>` into `docs/runbooks/`. Fields: `{{title}}`, `{{issue}}`, `{{date}}`, `{{check}}`, `{{greenCommit}}`, `{{base}}`, `{{files}}` and others. Steps: sync and drift check, files to push, `bin/check runbook push N --plan` then the push, apply (reload or restart; filled in by a person), read-only live check with `--target live` |
| `sync-rules` | The default rules a private repo starts from (`make setup` in the template copies it to the repo root unless one exists). Lines are `<class> <pattern>` (`<class>: <pattern>` also works); classes `skip` (never transferred or committed), `data` (pulled only by `bin/dev seed --with-data`, never committed) and `review` (proposed by `bin/dev inventory`, no effect). Patterns are gitignore-style, relative to the server root, and ignore case, like the private guard. Defaults skip logs, crash reports, spark tmp, WorldEdit archive-unpack, `.trash/`, `*.partial`, `*.zip` and `plugins/ajLeaderboards/past-resets/`, and mark `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite`, `*.mv.db`, `*.h2.db`, `userdata/` and `playerdata/` as data |

Parsing, matching and the rclone and `.gitignore` translations of `sync-rules` live in `src/sync/rules.ts`; rendering of the two markdown files lives in `src/gate/docs.ts`.

## For AI Agents

### Working In This Directory
- Placeholders are `{{field}}`. Add or rename a field only together with `src/gate/docs.ts`, and keep the `<!-- -->` hints; they mark what the author fills in.
- `postmortem` and `runbook` render only after a confirmed gate pass (and refuse an uncommitted confirm), so a template change does not weaken the gate.
- A change to the default `sync-rules` changes the `.gitignore` section in `template/.gitignore`, which `bin/dev sync` regenerates from the rules. Keep the two in step.
- `sync-rules` header comments document the syntax: `*` and `?` stay within one name; `**/` at the start and `/**/` inside match zero or more directories; a trailing `/` matches directories only; no `!`, no `..`.

### Testing Requirements
`make test-unit` (`test/ts/rules.test.ts` covers rules parsing, `test/ts/gate-cli.test.ts` the gate CLI that renders the docs). Run `make test` before committing a change that alters a rendered field or a rule class.

### Common Patterns
Markdown with `{{field}}` substitutions and `<!-- hint -->` comments; `sync-rules` is `#` comments plus one rule per line.

## Dependencies

### Internal
- `src/gate/docs.ts`: renders the postmortem and runbook
- `src/sync/rules.ts`: reads `sync-rules`
- `template/Makefile`: `make setup` copies `sync-rules`

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

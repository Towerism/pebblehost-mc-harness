# guard

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The path guard. It keeps server files, secrets and player data out of git: `paths.ts` holds the allowlist, the case-insensitive denylist and the 512 KB cap; `cli.ts` checks staged files or commits, and also refuses symlinks and copies of local server files. The private profile also refuses `server/` paths the repo's `sync-rules` mark skip or data. Run by `bin/path-guard` from the git hooks and CI.

## Key Files
| File | Description |
|------|-------------|
| `paths.ts` | `classify(path, size, profile)` returns why a path is refused, or `null`. Exports `Profile` (`'public'`/`'private'`), `MAX_BYTES` (512 KB), `Rule`, `PRIVATE_DENY`, `PUBLIC_DENY`. A rule is a directory name (any depth) or a basename glob (`*` only), matched ignoring case; the first match gives the reason. The public allowlist is `PUBLIC_DIRS` (`bin`, `hooks`, `src`, `test`, `docker`, `templates`, `template`, `docs`, `.github`) plus `PUBLIC_FILES` (`.claude/settings.json`, `Makefile`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.env.example`), `*.md` at the root, and OMC project skills: exactly `.omc/skills/<name>.md`, matched case-sensitively (`.OMC/`, `.MD` and a name starting with `.` stay refused) |
| `cli.ts` | `bin/path-guard` entry: `--staged`, `--range A..B` or `--history REV`, `--profile public\|private`. Exit 0 clean, 2 refused or error (never prompts). Lists every refused path with its reason, then points at `docs/leak-response.md` |

## For AI Agents

### Working In This Directory
- Deny rules win over the allowlist. `.env*` is refused in any case; only the exact `.env.example` passes. The private profile applies only `PRIVATE_DENY` (player data, databases, world files, archives) plus `.env*`; the public one adds server, local-state and jar rules and the allowlist and size cap.
- A new top-level directory or root file must be added to `PUBLIC_DIRS`/`PUBLIC_FILES`, with a test in `test/ts/guard.test.ts`.
- `--range` and `--history` check every path added or modified by every listed commit, not the net diff: a file added and then removed still lands in pushed history. `--staged`/commits use `--diff-filter=d` (deletions pass).
- `GIT_NO_REPLACE_OBJECTS=1` is set at start: a replace ref could show git a clean commit in place of the one pushed. Missing objects fail closed (`cannot size ...`).
- Symlinks (mode `120000`) are always refused. Gitlinks (mode `160000`, submodules) have size 0 and are exempt from the copy check.
- Copy check (public profile only): `serverBlobs()` hashes every file under `server/`, `backups/` and `.mc/` of this checkout, the main checkout of a linked worktree and the superproject (tracked ones from `ls-files`/`ls-tree`, untracked ones from disk), and refuses a committed blob with the same SHA. The empty blob is ignored; files over the cap are skipped (the cap refuses their copies anyway). Files are hashed in-process because a running pull adds and removes files mid-walk and a vanished file must not abort the check. In hooks, `GIT_DIR`/`GIT_INDEX_FILE` etc. are cleared before reading the superproject.
- Private profile: `readRules` (from `../sync/rules.ts`) loads the repo's `sync-rules` (defaults when none); a `server/` path matching a skip or data rule is refused as `sync-rules: <class> <pattern>`.
- Never bypass with `--no-verify`. Cherry-pick and rebase run no commit hook; `pre-push` and CI are the gate for those.

### Testing Requirements
`test/ts/guard.test.ts` covers every guard rule and the cap boundary; `test/unit/guard.bats` covers the hooks in a temp git repo; `test/ts/rules.test.ts` covers the private guard reading `sync-rules` (skip and data paths refused, `server.properties`, configs and jars allowed). Generate fixtures inside the test's temp directory; never commit them.

### Common Patterns
`die()` writes `path-guard: ...` to stderr and exits 2. Git is called through `execFileSync` with `maxBuffer: 1 << 30`; `gitOrNull` is for optional context (work tree, superproject).

## Dependencies

### Internal
- `../sync/rules.ts`: `readRules`, `matchRule`, `Rule` for the private profile

### External
- `git` (`diff --raw -z`, `diff-tree`, `rev-list`, `cat-file --batch-check`, `ls-files`, `ls-tree`, `worktree list`)
- `node:child_process`, `node:crypto`, `node:fs`

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

# gate

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The red/green gate for recorded checks: rules G1-G10 over the run records and a `GateRepo`, pure for the tests; the G8 static check for bare-text checks; and the postmortem and runbook renderer from `templates/`, only after a confirmed gate pass. `src/check/cli.ts` drives it (`bin/check gate`, `postmortem`, `runbook`).

## Key Files
| File | Description |
|------|-------------|
| `gate.ts` | `pairProblems(red, green, check, repo)` lists the rule failures of one pair (empty = passes). `evaluate(records, check, repo)` picks the newest green with an earlier red that passes every rule, else returns the reasons for the newest green and its newest earlier red; `confirm` records and `live` target records are filtered out, so they never stand in for a red or green. `confirmCheck(records, green)` / `confirmOf` find the latest confirm run of that green (the latest decides; a later failing confirm cancels an earlier pass) and say why it is disqualified. `GateRepo`/`gitRepo(root)`: git access (`head`, `checkHashAt`, `checkClean`, `isAncestor`, `serverChanges`, `serverTree`, `committedRuns`) |
| `bareText.ts` | G8. `tokenize` plus a strict parser accept only `import { test, bareText } from '#harness/unit'` and `test('name', () => bareText(file, path, literal))` (or a block of `bareText` calls). `parseBareText(src)` returns `{problems, files}` (files are what G4 needs the fix to touch); `bareTextProblems`; `literalProblems` refuses a literal holding a `%placeholder%`, `{placeholder}`, `<tag>`, `&` color/format code or `§` code |
| `docs.ts` | `writeDoc(root, 'postmortem'\|'runbook', red, green, confirm, live?)` renders `templates/<kind>.md` into `docs/postmortems/` or `docs/runbooks/` as `<date>-<issue>-<slug>.md` (refuses to overwrite). `render` replaces `{{field}}` and fails on a field with no value. `pushList` lists the `server/` changes of `main...HEAD` (deletions are manual steps). The postmortem carries the red/green/confirm records (output stripped), the `server/` diff stat and patch (cut at 400 lines), and the latest live record or a hint to run one |

## For AI Agents

### Working In This Directory
- Frozen (#30): read "Freeze" in `../../CLAUDE.md` before adding anything to `bin/check`.
- The rules, as coded: G1 both runs are dev target and the check's kind and issue, red older than green; G2 the check tree is unchanged red/green/HEAD and clean; G3 the green booted a strict descendant commit of the red's; G4 `server/` changed between them (bare-text: every file the check reads); G5 e2e images built from `archive` source with matching tree and image hashes, same harness hash, and same check/gate code (`toolHash`) for both kinds; G6 same fixtures hash; G7 HEAD descends from the green and `server/` did not change after it; G8 bare-text static check; G9 e2e: red and green were the first (`runIndex` 0), non-`concurrent` run on their volume, the red's volume was `fresh`, neither volume `explored`; G10 both record lines are committed as is in `.verify/runs/issue-N.jsonl` at HEAD.
- A confirm counts only as run `green.runIndex + 1` on the green's volume or run 0 on a new one (e2e), after the green, with the same fixtures, not explored and not concurrent. `confirmCheck` is the single place that decides it; `bin/check gate` pre-checks the same slot before running anything.
- `postmortem` and `runbook` keep no gate state: `src/check/cli.ts` (`confirmedPass`) re-evaluates the gate, requires a confirm and requires it committed (G10) before calling `writeDoc`.
- G4 only sees that `server/` changed, not whether the change fixes anything; the postmortem's "Fix diff review" is where each hunk gets justified.
- Records are compared as `JSON.stringify(record)`; a changed field order or edited line breaks G10 and the confirm lookup.
- Git goes through `git()` from `../dev/image.ts`, which sets `GIT_NO_REPLACE_OBJECTS=1`.

### Testing Requirements
`test/ts/gate.test.ts` covers every gate rule and refusal case and the G8 static check; `test/ts/gate-g8.test.ts` the bare-text path end to end; `test/ts/gate-cli.test.ts` and `test/ts/gate-confirm.test.ts` drive `gate`, `postmortem` and `runbook` end to end (split to run in parallel). `make test-dev` (`test/dev/verify.bats`) exercises the loop against a real pod. A new rule needs a pass case and a refusal case in `gate.test.ts`.

### Common Patterns
Rule messages are prefixed `G<n>:` and name the short (12-char) commit or hash. Rules are pure functions of records and `GateRepo`, so tests pass a fake repo.

## Dependencies

### Internal
- `../check/record.ts`: `RunRecord`, `Kind`
- `../dev/image.ts`: `git`, `HARNESS_ROOT`
- `../dev/docker.ts`: `fail`
- `templates/` (repo root): `postmortem.md`, `runbook.md`

### External
- `git`; `node:crypto`, `node:fs`

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

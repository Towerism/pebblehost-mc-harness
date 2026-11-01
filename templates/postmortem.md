# Postmortem: {{title}} (issue {{issue}})

Date: {{date}} · Check: `checks/{{check}}/` · Gate: passed

## Cause

<!-- What broke and why, in the plugin's or server's own terms. -->

## Evidence

<!-- What the server produced: log lines, database rows, the check's failure message. -->

The check failed on commit `{{redCommit}}` (a fresh volume) and passed on `{{greenCommit}}` after `bin/dev rebuild`; the gate's confirm run passed again.

## Fix

<!-- What changed and why it removes the cause. -->

Server files changed between the red and the green:

```
{{serverDiff}}
```

## Fix diff review

The gate only checks that `server/` changed between the red and the green (G4); it can't judge whether the change fixes the cause. Read the diff below and say, for each hunk, why it fixes the issue or why it is needed. A hunk you can't justify means the green may not come from the fix.

```diff
{{serverPatch}}
```

<!-- Review: why this diff fixes the cause, hunk by hunk. -->

Commit `.verify/runs/issue-{{issue}}.jsonl` with this postmortem: it holds the gate's confirm run.

## Wrong turns

<!-- Hypotheses that did not hold, and what disproved each. -->

## Run records

Red:

```json
{{red}}
```

Green:

```json
{{green}}
```

Confirm:

```json
{{confirm}}
```

Latest read-only live check (target live):

```json
{{live}}
```

Output of the red run (tail):

```
{{redOutput}}
```

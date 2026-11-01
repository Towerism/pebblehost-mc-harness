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

Output of the red run (tail):

```
{{redOutput}}
```

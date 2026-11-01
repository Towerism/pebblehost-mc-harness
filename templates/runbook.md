# Runbook: {{title}} (issue {{issue}})

Date: {{date}} · Check: `checks/{{check}}/` · Gate: passed on `{{greenCommit}}`

Run these steps in order and stop at the first one that fails. The user OKs the diff before step 3 and does the restart in step 4.

1. **Sync and drift check.** Run `bin/dev sync`. It must report no drift on the files of step 2 since `issue/{{issue}}` was cut from `{{base}}`.
2. **Files to push.** The `server/` changes of `{{base}}...issue/{{issue}}`:
{{files}}
3. **Push.** Run `bin/check runbook push {{issue}}`. It uploads exactly the files of step 2 and refuses on drift.
4. **Apply.** <!-- The plugin's reload command, or "restart from the panel". -->
5. **Live check, read-only.** Run `bin/check run {{check}} --target live --issue {{issue}}`. It must pass, and it is recorded with target=live.

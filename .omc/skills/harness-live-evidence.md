---
id: harness-live-evidence
name: harness-live-evidence
description: Measure an unmerged pebblehost-mc-harness change against the live server through the private server repo (submodule pointed at the feature branch, timed runs, pin restored) before the PR merges
triggers:
  - live evidence for the harness
  - time the harness change on live
  - test the harness branch against live
  - harness PR live timing
---

# Harness live evidence

A harness PR whose acceptance depends on the real server (sync time, boot parity, a bot joining the live copy) needs evidence from live before merge. The integration tests run against atmoz/sftp and a vanilla server. They cannot show PebbleHost's latency, its connection limits or the live plugin set.

## Inputs
- The feature branch in its worktree, e.g. `/omc-dev/mc/pebblehost-mc-harness-feature-<n>-<slug>`. It does not need to be pushed.
- The private server repo `/omc-dev/mc/survive-papitas-server`, whose `harness/` submodule is pinned in a commit.
- The user's OK for any live access beyond what the PR's spec already covers.

## Steps
1. **Check the private repo is free.** If an `issue/N` there is between its red and its gate, don't move the pin. The gate needs one harness for red, green and confirm. Finish or pause that loop first.
2. **Point the submodule at the branch, without pushing:**
   `git -C harness fetch <worktree> <branch> && git -C harness checkout FETCH_HEAD && (cd harness && npm ci --silent)`.
   Leave the superproject's pointer uncommitted.
3. **Estimate, then measure.** State the expected time first, then run the timed commands with `</dev/null` and `time`. Repeat at least three times back to back. The first run may take a fallback path (for example a full sync).
   Run nothing else against live meanwhile. PebbleHost's SFTP refuses connections under concurrency, and a parallel listing broke a running sync.
4. **Quote the numbers in the PR** (a table of runs and their output lines). If a revision changes the code path, measure again on the final commit.
5. **Restore the pin:**
   `git -C harness checkout <pinned commit> && (cd harness && npm ci --silent)`.
   `git status` in the private repo must be clean.

## Pitfalls
- A rebase or a revision after the measurement invalidates it. The evidence must come from the commit that merges, or one differing only in comments, docs and tests.
- A sync measured on the old pin re-downloads everything (about 5.5 min). The incremental path needs a stored listing whose tree matches `main`'s `server/`, and the first run after a merge to `main` falls back to the full pull.
- The private repo's pre-push hook allows only its Gitea remote. Never push the private repo while the submodule points at an unmerged commit.

## Success criteria
- The PR body holds the live numbers for the final code, and the acceptance limit is met (e.g. an incremental sync of 30 s or less).
- The private repo's harness pin is back on its committed commit, with a clean `git status`.

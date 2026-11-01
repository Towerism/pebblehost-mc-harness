# Dev tier: bin/check against a pod of the suite's vanilla project. Runs after
# dev.bats, which leaves no pod. The tests share state in file order. The
# check is a real e2e one: the difficulty the running server reports.

bats_require_minimum_version 1.5.0

check() {
  timeout 300 "$BATS_TEST_DIRNAME/../../bin/check" "$@" --issue "${ISSUE:-7}" </dev/null
}

dev() {
  timeout 300 "$DEV" "$@" </dev/null
}

# Field $2 of record $1 (0-based) in .verify/runs/issue-7.jsonl.
rec() {
  node -e 'const l = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n"); console.log(JSON.parse(l[process.argv[2]])[process.argv[3]])' "$MC_HOME/.verify/runs/issue-7.jsonl" "$1" "$2"
}

# The gate counts only records committed at HEAD (G10).
commit_records() {
  git -C "$MC_HOME" add .verify
  git -C "$MC_HOME" commit -q -m 'run records'
}

label() {
  docker inspect --format "{{index .Config.Labels \"mc-harness.$1\"}}" "$SERVER"
}

@test "setup: a committed difficulty check importing #harness/dev, and an easy server" {
  # dev.bats left pod.json with its --fixtures; start without, so every boot
  # here has the same (empty) fixtures even after .dev/ is deleted below.
  rm -rf "$MC_HOME/.dev"
  # No import map: bin/check run's loader resolves #harness/*. .verify/ is tracked.
  echo '{"type":"module"}' >"$MC_HOME/package.json"
  echo '.dev/' >"$MC_HOME/.gitignore"
  mkdir -p "$MC_HOME/checks/7-difficulty"
  echo '{"kind":"e2e"}' >"$MC_HOME/checks/7-difficulty/profile.json"
  cat >"$MC_HOME/checks/7-difficulty/difficulty.test.ts" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';

test('the server runs on normal difficulty', async () => {
  assert.equal(await dev.console('difficulty'), 'The difficulty is Normal');
});
EOF
  echo 'difficulty=easy' >>"$MC_HOME/server/server.properties"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'difficulty check, easy server'
}

@test "run refuses with exit 2 when no pod is up" {
  run check run 7-difficulty
  [ "$status" -eq 2 ]
  [[ $output == *"pod dev is not up"* ]]
}

@test "run --fresh boots HEAD on a fresh volume and records a red from the container labels" {
  run check run 7-difficulty --fresh
  echo "$output"
  [ "$status" -eq 1 ]
  [[ $output == *"The difficulty is Easy"* ]]
  [[ $output == *"run: 7-difficulty failed (e2e, commit "*"(fresh))"* ]]
  [ "$(rec 0 pass)" = false ]
  [ "$(rec 0 fresh)" = true ]
  [ "$(rec 0 explored)" = false ]
  [ "$(rec 0 commit)" = "$(git -C "$MC_HOME" rev-parse HEAD)" ]
  [ "$(rec 0 treeHash)" = "$(git -C "$MC_HOME" rev-parse HEAD:server)" ]
  [ "$(rec 0 checkHash)" = "$(git -C "$MC_HOME" rev-parse HEAD:checks/7-difficulty)" ]
  [ "$(rec 0 generation)" = "$(label generation)" ]
  [ "$(rec 0 generation)" = "$(docker volume inspect --format '{{index .Labels "mc-harness.generation"}}' "mc-$PROJECT-dev-server")" ]
  [ "$(rec 0 imageHash)" = "$(label image)" ]
  [ "$(label fresh)" = true ]
}

@test "bin/dev console marks the volume explored, in the volume: later records say so even without .dev/" {
  run dev console list
  [ "$status" -eq 0 ]
  docker exec "$SERVER" test -e /server/.mc-harness-explored
  rm -rf "$MC_HOME/.dev"
  run check run 7-difficulty
  [ "$status" -eq 1 ]
  [[ $output == *"explored: does not count as a red"* ]]
  [ "$(rec 1 explored)" = true ]
  # Issue 8's only red is on this explored volume.
  ISSUE=8 run check run 7-difficulty
  [ "$status" -eq 1 ]
}

@test "a green made by hand on the red's image is refused: it booted the red's commit" {
  run dev console difficulty normal
  [ "$status" -eq 0 ]
  run check run 7-difficulty
  [ "$status" -eq 0 ]
  [ "$(rec 2 commit)" = "$(rec 0 commit)" ]
  commit_records
  run check gate 7-difficulty
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"G3: the green booted "*"not a strict descendant"* ]]
}

@test "a no-op server commit, a rebuild and a repair on the console: the explored green is refused" {
  echo '# no-op' >>"$MC_HOME/server/server.properties"
  git -C "$MC_HOME" commit -q -am 'no-op server change'
  run dev rebuild
  [ "$status" -eq 0 ]
  run dev console difficulty normal
  [ "$status" -eq 0 ]
  run check run 7-difficulty
  [ "$status" -eq 0 ]
  [ "$(rec 3 explored)" = true ]
  commit_records
  run check gate 7-difficulty
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"G9: the green's volume "*" was explored"* ]]
}

@test "another committed check repairing the server first: the green is not the first run on its volume" {
  mkdir -p "$MC_HOME/checks/7-repair"
  echo '{"kind":"e2e"}' >"$MC_HOME/checks/7-repair/profile.json"
  cat >"$MC_HOME/checks/7-repair/repair.test.ts" <<'EOF'
import { test } from 'node:test';
import { dev } from '#harness/dev';

test('sets normal difficulty through the relay', async () => {
  await dev.console('difficulty normal');
});
EOF
  git -C "$MC_HOME" add checks/7-repair
  git -C "$MC_HOME" commit -q -m 'a check that repairs the server'
  run dev rebuild
  [ "$status" -eq 0 ]
  run check run 7-repair
  [ "$status" -eq 0 ]
  run check run 7-difficulty
  [ "$status" -eq 0 ]
  [ "$(rec 5 explored)" = false ]
  [ "$(rec 5 runIndex)" = 1 ]
  [ "$(docker exec "$SERVER" wc -l </dev/null /server/.mc-harness-runs | cut -d' ' -f1)" = 2 ]
  commit_records
  run check gate 7-difficulty
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"G9: the green was run 1 check run(s) into its volume"* ]]
}

@test "a fix commit counts only once rebuilt; then the gate passes, confirms, and allows the docs" {
  # HEAD has moved past the booted commit (record commits); the pod hasn't.
  booted=$(label commit)
  red=$(rec 0 commit)
  sed -i 's/^difficulty=easy$/difficulty=normal/' "$MC_HOME/server/server.properties"
  git -C "$MC_HOME" commit -q -am 'fix: normal difficulty'
  # Not rebuilt yet: the pod still reports the booted commit.
  run check run 7-difficulty
  [ "$(rec 6 commit)" = "$booted" ]
  run check postmortem 7-difficulty
  [ "$status" -eq 2 ]
  [[ $output == *"the gate refuses 7-difficulty"* ]]
  run dev rebuild
  [ "$status" -eq 0 ]
  run check run 7-difficulty
  [ "$status" -eq 0 ]
  [ "$(rec 7 commit)" = "$(git -C "$MC_HOME" rev-parse HEAD)" ]
  [ "$(rec 7 explored)" = false ]
  [ "$(rec 7 generation)" != "$(rec 0 generation)" ]
  # The records must be committed before the gate counts them.
  run check gate 7-difficulty
  [ "$status" -eq 2 ]
  [[ $output == *"G10: the green record is not committed"* ]]
  commit_records
  run check gate 7-difficulty
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"gate: 7-difficulty passed and confirmed"* ]]
  [ "$(rec 8 confirm)" = true ]
  [ "$(rec 8 pass)" = true ]
  # The docs need the confirm record committed too.
  run check postmortem 7-difficulty
  [ "$status" -eq 2 ]
  [[ $output == *"the confirm record of 7-difficulty is not committed"* ]]
  commit_records
  run check postmortem 7-difficulty
  [ "$status" -eq 0 ]
  pm=$(ls "$MC_HOME"/docs/postmortems/*-7-difficulty.md)
  grep -q "failed on commit \`$red\`" "$pm"
  grep -q '^+difficulty=normal' "$pm"
  run check runbook 7-difficulty
  [ "$status" -eq 0 ]
  grep -q 'bin/check run 7-difficulty --target live --issue 7' "$MC_HOME"/docs/runbooks/*-7-difficulty.md
}

@test "a red on an explored volume never counts, even with a valid green later" {
  ISSUE=8 run check run 7-difficulty
  [ "$status" -eq 0 ]
  commit_records
  ISSUE=8 run check gate 7-difficulty
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"G9: the red's volume "*" was explored"* ]]
}

@test "down --all leaves nothing labelled" {
  run dev down --all
  [ "$status" -eq 0 ]
  [ -z "$(docker ps -aq --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker volume ls -q --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker network ls -q --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker image ls -q --filter "label=mc-harness.project=$PROJECT")" ]
}

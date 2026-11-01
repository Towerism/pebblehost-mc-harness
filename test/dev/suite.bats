# Dev tier: bin/check suite over the suite's vanilla project. Runs after
# dev.bats (no pod left) and before verify.bats. Two fixture profiles of
# three e2e checks each (one fails on purpose, one restarts the server),
# plus a bare-text check, run twice.

bats_require_minimum_version 1.5.0

suite() {
  timeout 600 "$BATS_TEST_DIRNAME/../../bin/check" suite "$@" </dev/null
}

e2e() {
  mkdir -p "$MC_HOME/checks/$1"
  printf '%s\n' "$2" >"$MC_HOME/checks/$1/profile.json"
  cat >"$MC_HOME/checks/$1/a.test.ts"
}

nothing_labelled() {
  [ -z "$(docker ps -aq --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker volume ls -q --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker network ls -q --filter "label=mc-harness.project=$PROJECT")" ]
}

# Field of the newest timings.json, as a JS expression over `t`.
timing() {
  node -e 'const fs = require("fs"); const d = process.argv[1]; const last = fs.readdirSync(d).sort().pop(); const t = JSON.parse(fs.readFileSync(`${d}/${last}/timings.json`, "utf8")); console.log(eval(process.argv[2]))' "$MC_HOME/.dev/runs" "$1"
}

@test "setup: two fixture profiles of three e2e checks, a bare-text check, a tight budget" {
  echo '{"type":"module"}' >"$MC_HOME/package.json"
  echo '.dev/' >"$MC_HOME/.gitignore"
  e2e s-diff '{"kind":"e2e"}' <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('difficulty', async () => assert.match(await dev.console('difficulty'), /^The difficulty is /));
EOF
  e2e s-list '{"kind":"e2e"}' <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('list', async () => assert.match(await dev.console('list'), /players online/));
EOF
  e2e s-fail '{"kind":"e2e"}' <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('fails on purpose', async () => assert.equal(await dev.console('seed'), 'no such seed'));
EOF
  for id in s-fx1 s-fx2; do
    e2e "$id" '{"kind":"e2e","fixtures":["fx"]}' <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('fixture laid over the server', async () => assert.equal(await dev.file('fx.txt'), 'from the check\n'));
EOF
    mkdir -p "$MC_HOME/checks/$id/fx"
    echo 'from the check' >"$MC_HOME/checks/$id/fx/fx.txt"
  done
  e2e s-restart '{"kind":"e2e","fixtures":["fx"],"restart":true}' <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('state survives a restart', async () => {
  await dev.restart();
  assert.equal(await dev.file('fx.txt'), 'from the check\n');
  assert.match(await dev.console('list'), /players online/);
});
EOF
  mkdir -p "$MC_HOME/checks/s-restart/fx"
  echo 'from the check' >"$MC_HOME/checks/s-restart/fx/fx.txt"
  mkdir -p "$MC_HOME/checks/s-bare"
  echo '{"kind":"bare-text"}' >"$MC_HOME/checks/s-bare/profile.json"
  printf '%s\n' "import { test, bareText } from '#harness/unit';" "test('view distance', () => bareText('server.properties', 'view-distance', '3'));" >"$MC_HOME/checks/s-bare/a.test.ts"
  echo '{"seconds": 1}' >"$MC_HOME/checks/budget.json"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'suite checks'
}

@test "the suite runs the unit tier first, one pod per profile, reports each check and tears everything down" {
  run suite
  echo "$output"
  [ "$status" -eq 1 ]
  # Unit tier before any pod boots.
  [[ $output == "PASS s-bare"* ]]
  [[ $output == *"FAIL s-fail"* ]]
  for id in s-diff s-list s-fx1 s-fx2 s-restart; do [[ $output == *"PASS $id"* ]]; done
  [[ $output == *"suite: 7 check(s), 1 failed (s-fail); 2 pod(s)"* ]]
  [[ $output == *"OVER BUDGET by"* ]]
  # The restart check runs last on its profile's pod.
  [ "$(timing 't.profiles.map((p) => p.tests.map((x) => x.check).join(",")).join(" ")')" = 's-diff,s-fail,s-list s-fx1,s-fx2,s-restart' ]
  [ "$(timing 't.profiles.map((p) => p.reset).join(",")')" = 'none,restore' ]
  [ "$(timing 't.profiles.every((p) => p.boot > 0 && p.teardown > 0)')" = true ]
  [ "$(timing 't.image.cacheHit')" = false ]
  echo "$output" | grep -E '^(PASS|FAIL) ' | cut -d' ' -f1,2 | sort >"$BATS_SUITE_TMPDIR/first"
  nothing_labelled
}

@test "a second run gives the same results from the cached image and leaves nothing behind" {
  run suite
  [ "$status" -eq 1 ]
  [ "$(timing 't.image.cacheHit')" = true ]
  [ "$(timing 't.profiles.length')" = 2 ]
  diff "$BATS_SUITE_TMPDIR/first" <(echo "$output" | grep -E '^(PASS|FAIL) ' | cut -d' ' -f1,2 | sort)
  nothing_labelled
  "$DEV" down --all </dev/null
  [ -z "$(docker image ls -q --filter "label=mc-harness.project=$PROJECT")" ]
}

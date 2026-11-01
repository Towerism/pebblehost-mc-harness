# bin/check run and suite --target live against the shared SFTP container
# standing in for the live server: file, log and SQLite reads through
# bin/mc pull, the console and bots refused. Named to sort after mc.bats,
# whose root push must see only its own tree.

setup() {
  export RCLONE_RETRIES=1 RCLONE_LOW_LEVEL_RETRIES=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export MC_HOME=$BATS_TEST_TMPDIR/proj
  check=$BATS_TEST_DIRNAME/../../bin/check
  dir=upload/t$BATS_SUITE_TEST_NUMBER
  mkdir -p "$MC_HOME"
  git -C "$MC_HOME" init -q -b issue/4
  # The project's .env: bin/mc reads it; bin/check only passes its path.
  cat >"$MC_HOME/.env" <<ENV
PEBBLE_SFTP_HOST=127.0.0.1
PEBBLE_SFTP_PORT=$SFTP_PORT
PEBBLE_SFTP_USER=mc
PEBBLE_PANEL_PASSWORD='$SFTP_PASSWORD'
ENV
  printf '.env\n.dev/\n' >"$MC_HOME/.gitignore"
  echo '{"type":"module"}' >"$MC_HOME/package.json"
  mkdir -p "$MC_HOME/server"
  # The tracked copy says "dev"; live says "live": reads must come from live.
  printf 'motd=dev\n' >"$MC_HOME/server/server.properties"
  remote_sh "mkdir -p $dir/plugins/Eco && printf 'motd=live\n' >$dir/server.properties"
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("create table users (name text, coins int)"); db.prepare("insert into users values (?, ?)").run("steve", 7); db.close()' "$BATS_TEST_TMPDIR/data.db"
  docker cp -q "$BATS_TEST_TMPDIR/data.db" "$SFTP_CONTAINER:/home/mc/$dir/plugins/Eco/data.db"
  docker exec "$SFTP_CONTAINER" sh -c "chown $SFTP_UID /home/mc/$dir/plugins/Eco/data.db && mkdir -p /home/mc/logs && printf '[12:00:00] [Server thread/INFO]: Done (3.2s)!\n' >/home/mc/logs/latest.log && chown -R $SFTP_UID /home/mc/logs"
}

remote_sh() { docker exec -u "$SFTP_UID" -w /home/mc "$SFTP_CONTAINER" sh -c "$1"; }

add_check() {
  mkdir -p "$MC_HOME/checks/$1"
  printf '%s\n' "$2" >"$MC_HOME/checks/$1/profile.json"
  cat >"$MC_HOME/checks/$1/a.test.ts"
}

commit_all() {
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" -c user.name=t -c user.email=t@e commit -q -m checks
}

@test "a live run reads files, the log and SQLite over SFTP, skips a declared console need and records target live" {
  add_check 4-eco '{"kind":"e2e","needs":["console"]}' <<EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('file from live', async () => assert.equal(await dev.file('$dir/server.properties'), 'motd=live\n'));
test('sqlite from live', async () => assert.deepEqual(await dev.sqlite('$dir/plugins/Eco/data.db', 'select coins from users where name = ?', 'steve'), [{ coins: 7 }]));
test('log from live', async () => assert.match(await dev.logSince(Date.now()), /Done \(3\.2s\)/));
test('console is skipped on live', async () => { await dev.console('eco give steve 1'); });
EOF
  add_check 4-bare '{"kind":"bare-text"}' <<EOF
import { test, bareText } from '#harness/unit';
test('motd on live', () => bareText('$dir/server.properties', 'motd', 'live'));
EOF
  commit_all
  run "$check" run 4-eco --target live </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"run: 4-eco passed (e2e, live, read-only)"* ]]
  run "$check" run 4-bare --target live </dev/null
  [ "$status" -eq 0 ]
  node -e 'const rs = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse); if (!rs.every((r) => r.target === "live" && r.pass)) process.exit(1)' "$MC_HOME/.verify/runs/issue-4.jsonl"
  # Nothing pulled from live is kept.
  [ -z "$(ls -A "$MC_HOME/.dev/live")" ]
}

@test "an undeclared console call fails the live run; a check that only needs a bot exits 2; the live suite reports all three" {
  add_check 4-undeclared '{"kind":"e2e"}' <<EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('reads', async () => assert.match(await dev.file('$dir/server.properties'), /live/));
test('console', async () => { await dev.console('list'); });
EOF
  add_check 4-bot '{"kind":"e2e","needs":["bot"]}' <<'EOF'
import { test } from 'node:test';
import { bot } from '#harness/bot';
test('bot only', async () => { await bot.join('EcoBot'); });
EOF
  add_check 4-ok '{"kind":"e2e"}' <<EOF
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from '#harness/dev';
test('reads', async () => assert.match(await dev.file('$dir/server.properties'), /live/));
EOF
  commit_all
  run "$check" run 4-undeclared --target live </dev/null
  [ "$status" -eq 1 ]
  [[ $output == *"doesn't declare \"needs\": [\"console\"]"* ]]
  run "$check" run 4-bot --target live </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *"ran no test on live (1 skipped"* ]]
  run "$check" suite --target live </dev/null
  echo "$output"
  [ "$status" -eq 1 ]
  [[ $output == *"SKIP 4-bot"* && $output == *"FAIL 4-undeclared"* && $output == *"PASS 4-ok"* ]]
}

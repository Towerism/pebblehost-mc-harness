# bin/dev sync, seed --no-boot and inventory against the shared SFTP
# container standing in for live: its root (/home/mc) holds a small server
# tree, reset before each test. Sorts after mc.bats, whose root push must see
# only its own tree; the pod-booting seed is in test/dev/seed.bats.

setup() {
  export RCLONE_RETRIES=1 RCLONE_LOW_LEVEL_RETRIES=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export MC_HOME=$BATS_TEST_TMPDIR/proj
  dev=$BATS_TEST_DIRNAME/../../bin/dev
  git init -q -b main "$MC_HOME"
  git -C "$MC_HOME" config user.name test
  git -C "$MC_HOME" config user.email test@example.com
  cat >"$MC_HOME/.env" <<ENV
PEBBLE_SFTP_HOST=127.0.0.1
PEBBLE_SFTP_PORT=$SFTP_PORT
PEBBLE_SFTP_USER=mc
PEBBLE_PANEL_PASSWORD='$SFTP_PASSWORD'
ENV
  printf '.env\n.dev/\n.mc/\n' >"$MC_HOME/.gitignore"
  mkdir -p "$MC_HOME/server"
  echo 'motd=old' >"$MC_HOME/server/server.properties"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'initial server copy'
  # main lives in .dev/sync; the project works on another branch.
  git -C "$MC_HOME" switch -q -c work
  live_reset
  live 'printf "motd=live\n" >server.properties && printf "jar\n" >purpur.jar && mkdir -p plugins/Eco/userdata && printf "rate: 1\n" >plugins/Eco/config.yml && printf "db1" >plugins/Eco/data.db && printf "u: 1\n" >plugins/Eco/userdata/steve.yml'
}

# The live server root, as the SFTP user; reset to an empty tree first.
live() { docker exec -u "$SFTP_UID" -w /home/mc "$SFTP_CONTAINER" sh -c "$1"; }
live_reset() {
  docker exec "$SFTP_CONTAINER" sh -c 'cd /home/mc && rm -rf plugins config server.properties purpur.jar && mkdir plugins && chown '"$SFTP_UID"' plugins && chmod 755 /home/mc'
  docker exec "$SFTP_CONTAINER" sh -c 'touch /home/mc/server.properties /home/mc/purpur.jar && chown '"$SFTP_UID"' /home/mc/server.properties /home/mc/purpur.jar'
}

main_log() { git -C "$MC_HOME" log --format=%s main; }

@test "sync commits live drift on main only; a no-op or data-only change makes no commit" {
  run "$dev" sync </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'committed "live drift: 3 files" on main'* ]]
  [ "$(main_log | head -1)" = 'live drift: 3 files' ]
  [ "$(main_log | sed -n 2p)" = 'chore: regenerate the sync-rules section of .gitignore' ]
  [ "$(git -C "$MC_HOME" log -1 --format=%s work)" = 'initial server copy' ]
  [ "$(git -C "$MC_HOME" show main:server/server.properties)" = 'motd=live' ]
  # Data stays out of git.
  run git -C "$MC_HOME" ls-tree -r --name-only main
  [[ $output == *server/plugins/Eco/config.yml* && $output != *data.db* && $output != *userdata* ]]
  git -C "$MC_HOME" show main:.gitignore | grep -qx '/server/\*\*/\*.db'
  before=$(git -C "$MC_HOME" rev-parse main)
  run "$dev" sync </dev/null
  [ "$status" -eq 0 ]
  [[ $output == *'sync: no live drift'* ]]
  [ "$(git -C "$MC_HOME" rev-parse main)" = "$before" ]
  live 'printf "db2" >plugins/Eco/data.db && printf "u: 2\n" >plugins/Eco/userdata/steve.yml'
  run "$dev" sync </dev/null
  [[ $output == *'sync: no live drift'* ]]
  [ "$(git -C "$MC_HOME" rev-parse main)" = "$before" ]
  live 'printf "rate: 2\n" >plugins/Eco/config.yml'
  run "$dev" sync </dev/null
  [ "$(main_log | head -1)" = 'live drift: 1 files' ]
}

@test "the private guard refuses a database the repo's sync-rules let through; nothing is committed" {
  "$dev" sync </dev/null
  printf 'skip logs/\n' >"$MC_HOME/.dev/sync/sync-rules"
  git -C "$MC_HOME/.dev/sync" add sync-rules
  git -C "$MC_HOME/.dev/sync" commit -q -m 'sync-rules without data rules'
  before=$(git -C "$MC_HOME" rev-parse main)
  run "$dev" sync </dev/null
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"server/plugins/Eco/data.db: denied: *.db*"* ]]
  # Only the regenerated .gitignore section went in before the refusal.
  [ "$(git -C "$MC_HOME" log --format=%s "$before"..main)" = 'chore: regenerate the sync-rules section of .gitignore' ]
}

@test "a tracked file that becomes data is untracked in its own commit; the next sync is clean" {
  live 'printf "a: 1\n" >plugins/Eco/players.yml'
  "$dev" sync </dev/null
  git -C "$MC_HOME" cat-file -e main:server/plugins/Eco/players.yml
  printf '%s\n' "$(cat "$BATS_TEST_DIRNAME/../../templates/sync-rules")" 'data plugins/Eco/players.yml' >"$MC_HOME/.dev/sync/sync-rules"
  git -C "$MC_HOME/.dev/sync" add sync-rules
  git -C "$MC_HOME/.dev/sync" commit -q -m 'players.yml is data'
  live 'printf "a: 2\n" >plugins/Eco/players.yml'
  run "$dev" sync </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  run main_log
  [[ ${lines[1]} == 'chore: untrack plugin data (plugins/Eco/players.yml)' || ${lines[0]} == 'chore: untrack plugin data (plugins/Eco/players.yml)' ]]
  run git -C "$MC_HOME" cat-file -e main:server/plugins/Eco/players.yml
  [ "$status" -ne 0 ]
  run "$dev" sync </dev/null
  [[ $output == *'sync: no live drift'* ]]
}

@test "sync refuses when main is checked out in the project, or .dev/sync is not on main" {
  git -C "$MC_HOME" switch -q main
  run "$dev" sync </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *"main is checked out in"* ]]
  git -C "$MC_HOME" switch -q work
  "$dev" sync </dev/null
  git -C "$MC_HOME/.dev/sync" switch -q -c other
  run "$dev" sync </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *".dev/sync is on other, not main"* ]]
}

@test "seed reuses issue/N and its commits; a re-seed replaces .dev/seed-N" {
  run "$dev" seed 5 --with-data plugins/Eco/data.db plugins/Eco/userdata --no-boot </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"seed: created issue/5"* ]]
  [ "$(git -C "$MC_HOME" symbolic-ref --short HEAD)" = issue/5 ]
  [ "$(git -C "$MC_HOME" rev-parse issue/5)" = "$(git -C "$MC_HOME" rev-parse main)" ]
  [ "$(cat "$MC_HOME/.dev/seed-5/home/server/plugins/Eco/data.db")" = db1 ]
  [ -f "$MC_HOME/.dev/seed-5/home/server/plugins/Eco/userdata/steve.yml" ]
  echo fix >"$MC_HOME/server/fix.txt"
  git -C "$MC_HOME" add server/fix.txt
  git -C "$MC_HOME" commit -q -m 'the fix'
  git -C "$MC_HOME" switch -q work
  run "$dev" seed 5 --no-boot </dev/null
  [ "$status" -eq 0 ]
  [[ $output == *"seed: reused issue/5"* ]]
  [ "$(git -C "$MC_HOME" log -1 --format=%s issue/5)" = 'the fix' ]
  [ ! -e "$MC_HOME/.dev/seed-5/home/server" ]
}

@test "inventory proposes files live rewrites between its listings, and data-like directories, as review entries on main" {
  live 'mkdir -p plugins/Eco/PlayerData && printf "x" >plugins/Eco/PlayerData/a.json && printf "n: 1\n" >plugins/Eco/stats.yml'
  "$dev" inventory --wait 4 </dev/null >"$BATS_TEST_TMPDIR/inv" 2>&1 &
  pid=$!
  sleep 2
  live 'printf "n: 22\n" >plugins/Eco/stats.yml'
  wait "$pid"
  cat "$BATS_TEST_TMPDIR/inv"
  grep -q 'review plugins/Eco/stats.yml  (changed between the listings)' "$BATS_TEST_TMPDIR/inv"
  grep -q 'review plugins/Eco/PlayerData/  (data-like name)' "$BATS_TEST_TMPDIR/inv"
  git -C "$MC_HOME" show main:sync-rules | grep -qx 'review plugins/Eco/stats.yml'
  [[ $(main_log | head -1) == 'chore: sync-rules review entries from inventory ('*')' ]]
  # Review entries change nothing until promoted: config.yml is not proposed.
  run git -C "$MC_HOME" show main:sync-rules
  [[ $output != *config.yml* ]]
}

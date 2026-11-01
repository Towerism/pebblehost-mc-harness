# bin/dev sync, seed --no-boot and inventory against the shared SFTP
# container standing in for live: its root (/home/mc) holds a small server
# tree, reset before each test. Sorts after mc.bats, whose root push must see
# only its own tree; the pod-booting seed is in test/dev/seed.bats.

setup() {
  export RCLONE_RETRIES=1 RCLONE_LOW_LEVEL_RETRIES=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export MC_HOME=$BATS_TEST_TMPDIR/proj
  dev=$BATS_TEST_DIRNAME/../../bin/dev
  mc=$BATS_TEST_DIRNAME/../../bin/mc
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
  docker exec "$SFTP_CONTAINER" sh -c 'cd /home/mc && rm -rf plugins config libraries server.properties purpur.jar world world_nether && mkdir plugins && chown '"$SFTP_UID"' plugins && chmod 755 /home/mc'
  docker exec "$SFTP_CONTAINER" sh -c 'touch /home/mc/server.properties /home/mc/purpur.jar && chown '"$SFTP_UID"' /home/mc/server.properties /home/mc/purpur.jar'
}

main_log() { git -C "$MC_HOME" log --format=%s main; }

# A sync with stdin closed and a hard timeout.
dev_sync() { timeout 120 "$dev" sync "$@" </dev/null; }
# The start (epoch seconds, floored) of the listing the last sync stored.
listing_start() { node -e 'process.stdout.write(String(Math.floor(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).start)))' "$MC_HOME/.dev/sync-listing.json"; }
# Live's tracked files, dated well before any listing. The newest of them
# still fall in the window (120 s before the newest live mtime), so a sync
# with no change re-fetches them; older files stay put.
age() { live 'find server.properties purpur.jar plugins $(ls -d libraries 2>/dev/null) -type f -exec touch -d "2026-10-01 00:00:00" {} +'; }

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
  live 'mkdir -p plugins/Eco/StatsData && printf "x" >plugins/Eco/StatsData/a.json && printf "n: 1\n" >plugins/Eco/stats.yml'
  "$dev" inventory --wait 4 </dev/null >"$BATS_TEST_TMPDIR/inv" 2>&1 &
  pid=$!
  sleep 2
  live 'printf "n: 22\n" >plugins/Eco/stats.yml'
  wait "$pid"
  cat "$BATS_TEST_TMPDIR/inv"
  grep -q 'review plugins/Eco/stats.yml  (changed between the listings)' "$BATS_TEST_TMPDIR/inv"
  grep -q 'review plugins/Eco/StatsData/  (data-like name)' "$BATS_TEST_TMPDIR/inv"
  git -C "$MC_HOME" show main:sync-rules | grep -qx 'review plugins/Eco/stats.yml'
  [[ $(main_log | head -1) == 'chore: sync-rules review entries from inventory ('*')' ]]
  # Review entries change nothing until promoted: config.yml is not proposed.
  run git -C "$MC_HOME" show main:sync-rules
  [[ $output != *config.yml* ]]
}

# The exclude file bin/dev sync writes for a pull of $1 (skip rules only).
excludes() { node -e 'import(process.argv[1]).then((m) => process.stdout.write(m.rcloneExcludes(m.readRules("/nonexistent"), ["skip"], process.argv[2])))' "$BATS_TEST_DIRNAME/../../src/sync/rules.ts" "$1"; }

@test "skip trees on live stay out of sync and of bin/mc pull with MC_EXCLUDE_FILE; a skipped file's change doesn't make push refuse" {
  live 'mkdir -p plugins/ajLeaderboards/past-resets plugins/Eco/logs && printf "{}" >plugins/ajLeaderboards/past-resets/1.json && printf "l: 1\n" >plugins/ajLeaderboards/config.yml && printf "log\n" >plugins/Eco/logs/today.log'
  "$dev" sync </dev/null
  run git -C "$MC_HOME" ls-tree -r --name-only main
  [[ $output == *server/plugins/ajLeaderboards/config.yml* && $output != *past-resets* && $output != *today.log* ]]
  [ ! -e "$MC_HOME/.dev/sync/server/plugins/ajLeaderboards/past-resets" ]
  home=$BATS_TEST_TMPDIR/home
  mkdir -p "$home"
  excludes plugins >"$BATS_TEST_TMPDIR/ex"
  grep -qx '/ajLeaderboards/past-resets/\*\*' "$BATS_TEST_TMPDIR/ex"
  export MC_EXCLUDE_FILE=$BATS_TEST_TMPDIR/ex MC_ENV_FILE=$MC_HOME/.env
  MC_HOME=$home "$mc" pull plugins
  [ -f "$home/server/plugins/ajLeaderboards/config.yml" ]
  [ ! -e "$home/server/plugins/ajLeaderboards/past-resets" ]
  [ ! -e "$home/server/plugins/Eco/logs" ]
  # Live rewrites a skipped file: the push-drift snapshot doesn't see it.
  live 'printf "{\"a\":1}" >plugins/ajLeaderboards/past-resets/1.json && printf "{}" >plugins/ajLeaderboards/past-resets/2.json'
  echo 'l: 2' >"$home/server/plugins/ajLeaderboards/config.yml"
  run env MC_HOME="$home" "$mc" push plugins
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(live 'cat plugins/ajLeaderboards/config.yml')" = 'l: 2' ]
  [ "$(live 'ls plugins/ajLeaderboards/past-resets | wc -l')" -eq 2 ]
  # A change to a tracked file still makes it refuse.
  live 'printf "rate: 9\n" >plugins/Eco/config.yml'
  run env MC_HOME="$home" "$mc" push plugins
  [ "$status" -eq 2 ]
  [[ $output == *"remote 'plugins' changed since the last pull"* ]]
}

@test "seed pulls world*/ only with --with-worlds; data that holds no files boots with no fixtures" {
  docker exec "$SFTP_CONTAINER" sh -c "mkdir -p /home/mc/world/region /home/mc/world_nether && echo lvl >/home/mc/world/level.dat && echo n >/home/mc/world_nether/level.dat && chown -R $SFTP_UID /home/mc/world /home/mc/world_nether"
  live 'mkdir -p plugins/Empty/past && mkdir -p plugins/Logger/logs && printf "x\n" >plugins/Logger/logs/a.log'
  run "$dev" seed 6 --no-boot </dev/null
  [ "$status" -eq 0 ]
  [ ! -e "$MC_HOME/.dev/seed-6/home/server" ]
  git -C "$MC_HOME" switch -q work
  run "$dev" seed 6 --with-worlds --no-boot </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(cat "$MC_HOME/.dev/seed-6/home/server/world/level.dat")" = lvl ]
  [ -f "$MC_HOME/.dev/seed-6/home/server/world_nether/level.dat" ]
  [ ! -e "$MC_HOME/.dev/seed-6/home/server/plugins" ]
  [[ $output == *"seed: issue/6 ready with data in .dev/seed-6"* ]]
  # A directory with no files, and one whose files are all skipped.
  run "$dev" seed 6 --with-data plugins/Empty plugins/Logger --no-boot </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"seed: the data paths held no files to pull; booting with no data fixtures"* ]]
  [[ $output == *"seed: issue/6 ready; no pod booted"* ]]
  run "$dev" seed 6 --with-data plugins/ajLeaderboards/past-resets --no-boot </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *"sync-rules skip plugins/ajLeaderboards/past-resets/ covers it"* ]]
}

@test "a second sync with no change downloads no changed file and commits nothing; a changed file is one download and one drift commit; a file gone from live is removed" {
  live 'printf "a: 1\n" >plugins/Eco/gone.yml'
  age
  live 'touch -d "2026-09-01 00:00:00" plugins/Eco/config.yml'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: full pull (no stored listing)'* ]]
  [[ $output == *'sync: done in '* ]]
  before=$(git -C "$MC_HOME" rev-parse main)
  # Unreadable on live and older than the window: downloading it would fail.
  live 'chmod 000 plugins/Eco/config.yml'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: downloaded 0 changed files, removed 0; re-fetched 3 in the window'* ]]
  [[ $output == *'sync: no live drift'* ]]
  [[ $output == *'sync: done in '* ]]
  [ "$(git -C "$MC_HOME" rev-parse main)" = "$before" ]
  live 'chmod 644 plugins/Eco/config.yml && printf "rate: 22\n" >plugins/Eco/config.yml && touch -d "2026-10-02 00:00:00" plugins/Eco/config.yml'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: downloaded 1 changed files, removed 0'* ]]
  [ "$(main_log | head -1)" = 'live drift: 1 files' ]
  [ "$(git -C "$MC_HOME" show main:server/plugins/Eco/config.yml)" = 'rate: 22' ]
  live 'rm plugins/Eco/gone.yml'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: downloaded 0 changed files, removed 1'* ]]
  [ "$(main_log | head -1)" = 'live drift: 1 files' ]
  [ "$(git -C "$MC_HOME" show --format= --name-status main)" = "$(printf 'D\tserver/plugins/Eco/gone.yml')" ]
}

@test "a same-size edit that keeps a modtime inside the window is pulled again" {
  age
  dev_sync
  # Dated at the stored listing's start, so the next listing stores it in
  # the window; then rewritten at the same size with the same modtime.
  at=$(listing_start)
  live "printf 'rate: 3\n' >plugins/Eco/config.yml && touch -d @$at plugins/Eco/config.yml"
  run dev_sync
  echo "$output"
  [ "$(git -C "$MC_HOME" show main:server/plugins/Eco/config.yml)" = 'rate: 3' ]
  live "printf 'rate: 4\n' >plugins/Eco/config.yml && touch -d @$at plugins/Eco/config.yml"
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: downloaded 0 changed files, removed 0; re-fetched '* ]]
  [ "$(main_log | head -1)" = 'live drift: 1 files' ]
  [ "$(git -C "$MC_HOME" show main:server/plugins/Eco/config.yml)" = 'rate: 4' ]
}

@test "libraries/ is listed again only when a root jar or a plugins/*.jar changes, when sync-rules change, or with --full" {
  docker exec "$SFTP_CONTAINER" sh -c "mkdir /home/mc/libraries && chown $SFTP_UID /home/mc/libraries"
  live 'mkdir -p libraries/a && printf "l1" >libraries/a/one.jar && printf "p1" >plugins/Eco.jar'
  age
  dev_sync
  git -C "$MC_HOME" cat-file -e main:server/libraries/a/one.jar
  live 'printf "l2" >libraries/a/two.jar'
  age
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: libraries, versions, cache: kept the last listing (no jar or sync-rules change)'* ]]
  [[ $output == *'sync: no live drift'* ]]
  live 'printf "jar 2\n" >purpur.jar'
  age
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: libraries, versions, cache: listed again (a root or plugins/ jar changed)'* ]]
  [ "$(main_log | head -1)" = 'live drift: 2 files' ]
  git -C "$MC_HOME" cat-file -e main:server/libraries/a/two.jar
  live 'printf "l3" >libraries/a/three.jar && printf "p22" >plugins/Eco.jar'
  age
  run dev_sync
  echo "$output"
  [[ $output == *'listed again (a root or plugins/ jar changed)'* ]]
  [ "$(main_log | head -1)" = 'live drift: 2 files' ]
  git -C "$MC_HOME" cat-file -e main:server/libraries/a/three.jar
  live 'printf "l4" >libraries/a/four.jar'
  age
  printf '%s\n' "$(cat "$BATS_TEST_DIRNAME/../../templates/sync-rules")" 'skip libraries/a/one.jar' >"$MC_HOME/.dev/sync/sync-rules"
  git -C "$MC_HOME/.dev/sync" add sync-rules
  git -C "$MC_HOME/.dev/sync" commit -q -m 'skip one.jar'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'listed again (sync-rules changed)'* ]]
  git -C "$MC_HOME" cat-file -e main:server/libraries/a/four.jar
  run git -C "$MC_HOME" cat-file -e main:server/libraries/a/one.jar
  [ "$status" -ne 0 ]
  live 'printf "l5" >libraries/a/five.jar'
  age
  run dev_sync --full
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'sync: full pull (--full)'* ]]
  [ "$(main_log | head -1)" = 'live drift: 1 files' ]
  git -C "$MC_HOME" cat-file -e main:server/libraries/a/five.jar
  run dev_sync
  [[ $output == *'sync: downloaded 0 changed files, removed 0'* ]]
}

@test "a download that fails midway exits 2 with no drift commit and the stored listing unchanged; the next sync recovers" {
  age
  dev_sync
  listing=$(cat "$MC_HOME/.dev/sync-listing.json")
  before=$(git -C "$MC_HOME" rev-parse main)
  live 'printf "a: 1\n" >plugins/Eco/a.yml && printf "b: 1\n" >plugins/Eco/b.yml && chmod 000 plugins/Eco/b.yml'
  run dev_sync
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *'download of '*' files failed'* ]]
  [ "$(git -C "$MC_HOME" rev-parse main)" = "$before" ]
  [ "$(cat "$MC_HOME/.dev/sync-listing.json")" = "$listing" ]
  live 'chmod 644 plugins/Eco/b.yml'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(main_log | head -1)" = 'live drift: 2 files' ]
  [ "$(git -C "$MC_HOME" show main:server/plugins/Eco/b.yml)" = 'b: 1' ]
}

@test "a directory replaced by a file on live syncs: the emptied directory is pruned" {
  live 'mkdir -p plugins/Eco/thing && printf "x\n" >plugins/Eco/thing/a.yml'
  age
  dev_sync
  live 'rm -r plugins/Eco/thing && printf "file\n" >plugins/Eco/thing'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(main_log | head -1)" = 'live drift: 2 files' ]
  [ "$(git -C "$MC_HOME" show main:server/plugins/Eco/thing)" = 'file' ]
}

@test "data and skip rules match names in any case; a stored listing that no longer matches main falls back to a full pull" {
  live 'mkdir -p plugins/GriefPreventionData/PlayerData && printf "x" >plugins/GriefPreventionData/PlayerData/u.yml && printf "c: 1\n" >plugins/GriefPreventionData/config.yml'
  age
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  run git -C "$MC_HOME" ls-tree -r --name-only main
  [[ $output == *server/plugins/GriefPreventionData/config.yml* && $output != *PlayerData* ]]
  live 'printf "y" >plugins/GriefPreventionData/PlayerData/v.yml'
  run dev_sync
  echo "$output"
  [[ $output == *'sync: no live drift'* ]]
  # main's server/ changed behind sync's back: the listing can't be trusted.
  git -C "$MC_HOME/.dev/sync" rm -q server/plugins/Eco/config.yml
  git -C "$MC_HOME/.dev/sync" commit -q -m 'hand edit'
  run dev_sync
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"sync: full pull (main's server/ changed since the stored listing)"* ]]
  git -C "$MC_HOME" cat-file -e main:server/plugins/Eco/config.yml
}

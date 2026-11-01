# End-to-end tests for bin/mc against the shared SFTP container from setup_suite.bash.

setup() {
  export MC_HOME=$BATS_TEST_TMPDIR
  # Fail fast: a local container needs no retries.
  export RCLONE_RETRIES=1 RCLONE_LOW_LEVEL_RETRIES=1
  mc=$BATS_TEST_DIRNAME/../../bin/mc
  cat >"$MC_HOME/.env" <<ENV
PEBBLE_SFTP_HOST=127.0.0.1
PEBBLE_SFTP_PORT=$SFTP_PORT
PEBBLE_SFTP_USER=mc
PEBBLE_PANEL_PASSWORD='$SFTP_PASSWORD'
ENV
  # Each test gets its own remote tree, so the container is never reset.
  dir=upload/t$BATS_SUITE_TEST_NUMBER
  remote_sh "mkdir -p $dir/plugins/Crates && printf 'reward: diamond\n' >$dir/plugins/Crates/crates.yml && printf 'debug: false\n' >$dir/plugins/Crates/config.yml"
}

remote_sh() { docker exec -u "$SFTP_UID" -w /home/mc "$SFTP_CONTAINER" sh -c "$1"; }

# First, so the root holds only this test's tree and the root pull stays small.
@test "push of the server root works only with --all" {
  run "$mc" push .
  [ "$status" -eq 2 ]
  [[ $output == *"needs --all"* ]]
  "$mc" pull . --all
  echo 'reward: emerald' >"$MC_HOME/server/$dir/plugins/Crates/crates.yml"
  run "$mc" push . --all
  [ "$status" -eq 0 ]
  [ "$(remote_sh "cat $dir/plugins/Crates/crates.yml")" = "reward: emerald" ]
}

@test "ls lists remote files" {
  run "$mc" ls "$dir/plugins/Crates"
  [ "$status" -eq 0 ]
  [[ $output == *"crates.yml"* ]]
}

@test "ls -l shows byte sizes and marks directories" {
  run "$mc" ls -l "$dir/plugins/Crates"
  [ "$status" -eq 0 ]
  [[ $output =~ (^|$'\n')' '+16'  '[0-9]{4}-[0-9]{2}-[0-9]{2}' '[0-9:]{8}'  crates.yml'($|$'\n') ]]
  run "$mc" ls -l "$dir/plugins"
  [ "$status" -eq 0 ]
  [[ $output =~ ' '+'-  '[0-9-]{10}' '[0-9:]{8}'  Crates/' ]]
}

@test "pull, edit, diff, push round-trips a directory" {
  "$mc" pull "$dir/plugins/Crates"
  [ "$(cat "$MC_HOME/server/$dir/plugins/Crates/crates.yml")" = "reward: diamond" ]
  echo 'reward: emerald' >"$MC_HOME/server/$dir/plugins/Crates/crates.yml"

  run "$mc" diff "$dir/plugins/Crates"
  [ "$status" -eq 1 ]
  [[ $output == *"-reward: diamond"* && $output == *"+reward: emerald"* ]]

  run "$mc" push "$dir/plugins/Crates"
  [ "$status" -eq 0 ]
  [ "$(remote_sh "cat $dir/plugins/Crates/crates.yml")" = "reward: emerald" ]
  run "$mc" diff "$dir/plugins/Crates"
  [ "$status" -eq 0 ]
}

@test "push of a single file writes a backup of the previous remote copy" {
  "$mc" pull "$dir/plugins/Crates/config.yml"
  echo 'debug: true' >"$MC_HOME/server/$dir/plugins/Crates/config.yml"
  run "$mc" push "$dir/plugins/Crates/config.yml"
  [ "$status" -eq 0 ]
  backup=$(find "$MC_HOME/backups" -path "*/remote/$dir/plugins/Crates/config.yml")
  [ "$(cat "$backup")" = "debug: false" ]
  [ "$(remote_sh "cat $dir/plugins/Crates/config.yml")" = "debug: true" ]
}

@test "push is refused when the remote changed after pull" {
  "$mc" pull "$dir/plugins/Crates"
  remote_sh "printf 'reward: netherite ingot\n' >$dir/plugins/Crates/crates.yml"
  echo 'reward: emerald' >"$MC_HOME/server/$dir/plugins/Crates/crates.yml"
  run "$mc" push "$dir/plugins/Crates"
  [ "$status" -eq 2 ]
  [[ $output == *"changed since the last pull"* ]]
  [ "$(remote_sh "cat $dir/plugins/Crates/crates.yml")" = "reward: netherite ingot" ]
}

@test "a file deleted remotely is not resurrected by the next push" {
  "$mc" pull "$dir/plugins/Crates"
  remote_sh "rm $dir/plugins/Crates/config.yml"
  "$mc" pull "$dir/plugins/Crates"
  [ ! -e "$MC_HOME/server/$dir/plugins/Crates/config.yml" ]
  echo 'reward: emerald' >"$MC_HOME/server/$dir/plugins/Crates/crates.yml"
  "$mc" push "$dir/plugins/Crates"
  run remote_sh "test -e $dir/plugins/Crates/config.yml"
  [ "$status" -ne 0 ]
}

@test "wrong password fails without echoing it" {
  sed -i "s/^PEBBLE_PANEL_PASSWORD=.*/PEBBLE_PANEL_PASSWORD=nope-secret/" "$MC_HOME/.env"
  run "$mc" ls "$dir"
  [ "$status" -ne 0 ]
  [[ $output != *nope-secret* ]]
}

@test "an empty remote directory pulls as nothing, diffs as all-new, and takes a push" {
  remote_sh "mkdir -p $dir/plugins/Empty"
  run "$mc" pull "$dir/plugins/Empty"
  [ "$status" -eq 0 ]
  mkdir -p "$MC_HOME/server/$dir/plugins/Empty"
  echo 'a: 1' >"$MC_HOME/server/$dir/plugins/Empty/new.yml"
  run "$mc" diff "$dir/plugins/Empty"
  [ "$status" -eq 1 ]
  [[ $output == *"+a: 1"* ]]
  run "$mc" push "$dir/plugins/Empty"
  [ "$status" -eq 0 ]
  [ "$(remote_sh "cat $dir/plugins/Empty/new.yml")" = "a: 1" ]
}

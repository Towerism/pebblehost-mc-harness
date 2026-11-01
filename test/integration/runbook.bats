# bin/check runbook push and rollback against the shared SFTP container as
# live: its root (/home/mc) holds a small server tree, reset before each
# test, and a temp private-shaped project has main mirroring it and issue/9
# changing it. Sorts after mc.bats, whose root push must see only its tree.

setup() {
  export RCLONE_LOW_LEVEL_RETRIES=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export MC_HOME=$BATS_TEST_TMPDIR/proj
  check=$BATS_TEST_DIRNAME/../../bin/check
  live_reset
  live 'mkdir -p plugins/Eco plugins/Other && printf "rate: 1\n" >plugins/Eco/config.yml && printf "a: 1\n" >plugins/Eco/a.yml && printf "b: 1\n" >plugins/Eco/b.yml && printf "o: 1\n" >plugins/Other/x.yml && printf "old\n" >plugins/Eco/old.yml'
  git init -q -b main "$MC_HOME"
  git -C "$MC_HOME" config user.name test
  git -C "$MC_HOME" config user.email test@example.com
  cat >"$MC_HOME/.env" <<ENV
PEBBLE_SFTP_HOST=127.0.0.1
PEBBLE_SFTP_PORT=$SFTP_PORT
PEBBLE_SFTP_USER=mc
PEBBLE_PANEL_PASSWORD='$SFTP_PASSWORD'
ENV
  printf '.env\n.dev/\n' >"$MC_HOME/.gitignore"
  mkdir -p "$MC_HOME/server/plugins/Eco" "$MC_HOME/server/plugins/Other"
  printf 'rate: 1\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  printf 'a: 1\n' >"$MC_HOME/server/plugins/Eco/a.yml"
  printf 'b: 1\n' >"$MC_HOME/server/plugins/Eco/b.yml"
  printf 'o: 1\n' >"$MC_HOME/server/plugins/Other/x.yml"
  printf 'old\n' >"$MC_HOME/server/plugins/Eco/old.yml"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'live drift: 5 files'
  git -C "$MC_HOME" switch -q -c issue/9
  mkdir -p "$MC_HOME/docs/runbooks"
  echo runbook >"$MC_HOME/docs/runbooks/2026-11-01-9-eco.md"
}

live() { docker exec -u "$SFTP_UID" -w /home/mc "$SFTP_CONTAINER" sh -c "$1"; }
live_reset() {
  docker exec "$SFTP_CONTAINER" sh -c 'cd /home/mc && rm -rf plugins config server.properties purpur.jar && mkdir plugins && chown '"$SFTP_UID"' plugins && chmod 755 /home/mc'
}
issue_commit() { git -C "$MC_HOME" add -A && git -C "$MC_HOME" commit -q -m "$1"; }

@test "push uploads only issue/N's server/ files, new ones included, with backups and a journal; rollback's commands restore live" {
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  mkdir -p "$MC_HOME/server/plugins/Eco/lang" "$MC_HOME/checks/9-eco"
  printf 'hi: x\n' >"$MC_HOME/server/plugins/Eco/lang/en.yml"
  echo '{"kind":"e2e"}' >"$MC_HOME/checks/9-eco/profile.json"
  git -C "$MC_HOME" rm -q server/plugins/Eco/old.yml
  issue_commit 'fix'
  run "$check" runbook push 9 --plan </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"not pushed: checks/9-eco/profile.json"* && $output == *"not pushed: docs/runbooks/2026-11-01-9-eco.md"* ]]
  [[ $output == *"manual: delete server/plugins/Eco/old.yml on live by hand"* ]]
  [[ $output == *"+rate: 2"* && $output == *"+hi: x"* ]]
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: 1' ]
  run "$check" runbook push 9 </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: 2' ]
  [ "$(live 'cat plugins/Eco/lang/en.yml')" = 'hi: x' ]
  [ "$(live 'cat plugins/Eco/old.yml')" = 'old' ]
  live 'test ! -e checks && test ! -e docs && test ! -e plugins/Eco/a.yml.partial'
  # Siblings of the new directory were left alone.
  [ "$(live 'cat plugins/Eco/a.yml')" = 'a: 1' ]
  journal=$MC_HOME/.dev/runbook-9/journal.jsonl
  [ "$(grep -c '"status":"ok"' "$journal")" -eq 2 ]
  backup=$(grep '"transfer":"plugins/Eco/config.yml"' "$journal" | sed 's/.*"backup":"\([^"]*\)".*/\1/')
  [[ $backup == "$MC_HOME/.dev/runbook-9/home/backups/"* ]]
  [ "$(cat "$backup/remote/plugins/Eco/config.yml")" = 'rate: 1' ]
  [ "$(stat -c %a "$MC_HOME/.dev/runbook-9")" = 700 ]
  run "$check" runbook rollback 9 </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"new on live: delete by hand: server/plugins/Eco/lang/en.yml"* ]]
  grep -v '^#' <<<"$output" >"$BATS_TEST_TMPDIR/rollback.sh"
  bash -e "$BATS_TEST_TMPDIR/rollback.sh"
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: 1' ]
}

@test "push refuses drift on main or on live since the cut, before writing anything" {
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  issue_commit 'fix'
  live 'printf "rate: live\n" >plugins/Eco/config.yml'
  run "$check" runbook push 9 </dev/null
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"live's plugins/Eco/config.yml differs from main's"* ]]
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: live' ]
  [ ! -e "$MC_HOME/.dev/runbook-9/journal.jsonl" ]
  # Synced into main: now main drifted.
  git -C "$MC_HOME" switch -q main
  printf 'rate: live\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  git -C "$MC_HOME" commit -q -am 'live drift: 1 files'
  git -C "$MC_HOME" switch -q issue/9
  run "$check" runbook push 9 </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *"main changed plugins/Eco/config.yml after issue/9 was cut"* ]]
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: live' ]
}

@test "an upload failing on the 2nd of 3 files stops with a journal of 1 ok and 1 failed; the backups outlive the run" {
  printf 'a: 2\n' >"$MC_HOME/server/plugins/Eco/a.yml"
  printf 'b: 2\n' >"$MC_HOME/server/plugins/Eco/b.yml"
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  issue_commit 'fix'
  # b.yml readable but not writable by the SFTP user.
  docker exec "$SFTP_CONTAINER" sh -c 'chown root /home/mc/plugins/Eco/b.yml && chmod 644 /home/mc/plugins/Eco/b.yml'
  run "$check" runbook push 9 </dev/null
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"push of plugins/Eco/b.yml failed; stopped"* ]]
  journal=$MC_HOME/.dev/runbook-9/journal.jsonl
  [ "$(wc -l <"$journal")" -eq 2 ]
  [ "$(sed -n 1p "$journal" | grep -c '"transfer":"plugins/Eco/a.yml".*"status":"ok"')" -eq 1 ]
  [ "$(sed -n 2p "$journal" | grep -c '"transfer":"plugins/Eco/b.yml".*"status":"failed"')" -eq 1 ]
  [ "$(live 'cat plugins/Eco/a.yml')" = 'a: 2' ]
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: 1' ]
  for t in a b; do
    backup=$(grep "\"transfer\":\"plugins/Eco/$t.yml\"" "$journal" | sed 's/.*"backup":"\([^"]*\)".*/\1/')
    [ "$(cat "$backup/remote/plugins/Eco/$t.yml")" = "$t: 1" ]
  done
  # Once the cause is fixed, rollback's commands restore both.
  docker exec "$SFTP_CONTAINER" sh -c "chown $SFTP_UID /home/mc/plugins/Eco/b.yml"
  run "$check" runbook rollback 9 </dev/null
  [ "$status" -eq 0 ]
  grep -v '^#' <<<"$output" >"$BATS_TEST_TMPDIR/rollback.sh"
  bash -e "$BATS_TEST_TMPDIR/rollback.sh"
  [ "$(live 'cat plugins/Eco/a.yml')" = 'a: 1' ]
  [ "$(live 'cat plugins/Eco/b.yml')" = 'b: 1' ]
}

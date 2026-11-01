# bin/check runbook push and rollback against the shared SFTP container as
# live: its root (/home/mc) holds a small server tree, reset before each
# test, and a temp private-shaped project has main mirroring it and issue/9
# changing it. Each push runs after a real bare-text gate pass on issue/9
# (red, fix commit, green, gate with its confirm, the runbook), all offline.
# Sorts after mc.bats, whose root push must see only its tree.

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
  echo '{"type":"module"}' >"$MC_HOME/package.json"
  mkdir -p "$MC_HOME/server/plugins/Eco" "$MC_HOME/server/plugins/Other"
  printf 'rate: 1\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  printf 'a: 1\n' >"$MC_HOME/server/plugins/Eco/a.yml"
  printf 'b: 1\n' >"$MC_HOME/server/plugins/Eco/b.yml"
  printf 'o: 1\n' >"$MC_HOME/server/plugins/Other/x.yml"
  printf 'old\n' >"$MC_HOME/server/plugins/Eco/old.yml"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'live drift: 5 files'
  git -C "$MC_HOME" switch -q -c issue/9
  # The check, then its red on the unfixed tree.
  mkdir -p "$MC_HOME/checks/9-eco"
  echo '{"kind":"bare-text"}' >"$MC_HOME/checks/9-eco/profile.json"
  printf "import { test, bareText } from '#harness/unit';\ntest('rate', () => bareText('plugins/Eco/config.yml', 'rate', '2'));\n" >"$MC_HOME/checks/9-eco/rate.test.ts"
  issue_commit 'check'
  run "$check" run 9-eco </dev/null
  [ "$status" -eq 1 ]
}

live() { docker exec -u "$SFTP_UID" -w /home/mc "$SFTP_CONTAINER" sh -c "$1"; }
live_reset() {
  docker exec "$SFTP_CONTAINER" sh -c 'cd /home/mc && rm -rf plugins config server.properties purpur.jar && mkdir plugins && chown '"$SFTP_UID"' plugins && chmod 755 /home/mc'
}
issue_commit() { git -C "$MC_HOME" add -A && git -C "$MC_HOME" commit -q -m "$1"; }

# Commit the test's server edits as the fix and take it through the gate:
# green, records, gate and its confirm, the runbook, each committed.
gate_issue() {
  issue_commit fix
  "$check" run 9-eco </dev/null
  issue_commit 'records'
  "$check" gate 9-eco </dev/null
  issue_commit 'confirm'
  "$check" runbook 9-eco </dev/null
  issue_commit 'runbook'
}

@test "push uploads only issue/N's server/ files, new ones included, with backups and a journal; rollback's commands restore live" {
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  mkdir -p "$MC_HOME/server/plugins/Eco/lang"
  printf 'hi: x\n' >"$MC_HOME/server/plugins/Eco/lang/en.yml"
  git -C "$MC_HOME" rm -q server/plugins/Eco/old.yml
  gate_issue
  run "$check" runbook push 9 --plan </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"not pushed: checks/9-eco/profile.json"* && $output == *"not pushed: docs/runbooks/"*"-9-eco.md"* && $output == *"not pushed: .verify/runs/issue-9.jsonl"* ]]
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

@test "a new directory named like a live sibling in another case still goes up" {
  live 'mkdir -p plugins/Eco/Lang && printf "L\n" >plugins/Eco/Lang/x.yml'
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  mkdir -p "$MC_HOME/server/plugins/Eco/lang"
  printf 'hi: y\n' >"$MC_HOME/server/plugins/Eco/lang/en.yml"
  gate_issue
  run "$check" runbook push 9 </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(live 'cat plugins/Eco/lang/en.yml')" = 'hi: y' ]
  [ "$(live 'cat plugins/Eco/Lang/x.yml')" = 'L' ]
}

@test "push refuses drift on main or on live since the cut, before writing anything" {
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  gate_issue
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
  gate_issue
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

@test "push and --plan need the gate: a runbook doc with no records is refused with nothing written" {
  # A runbook doc but no records at all.
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  issue_commit fix
  mkdir -p "$MC_HOME/docs/runbooks"
  echo fake >"$MC_HOME/docs/runbooks/2026-11-01-9-eco.md"
  rm -rf "$MC_HOME/.verify"
  issue_commit 'fake runbook, records dropped'
  for plan in --plan ''; do
    run "$check" runbook push 9 $plan </dev/null
    echo "$output"
    [ "$status" -eq 2 ]
    [[ $output == *"runbook push 9: the gate refuses 9-eco"* ]]
  done
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: 1' ]
  [ ! -e "$MC_HOME/.dev/runbook-9/journal.jsonl" ]
}

@test "a server/ edit committed after the green is refused at push time" {
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  gate_issue
  printf 'a: sneaked\n' >"$MC_HOME/server/plugins/Eco/a.yml"
  issue_commit 'after the green'
  run "$check" runbook push 9 </dev/null
  echo "$output"
  [ "$status" -eq 2 ]
  [[ $output == *"runbook push 9: the gate refuses 9-eco"* ]]
  [ "$(live 'cat plugins/Eco/a.yml')" = 'a: 1' ]
  [ "$(live 'cat plugins/Eco/config.yml')" = 'rate: 1' ]
}

@test "sync-rules skip and data paths, symlinks, typechanges and odd names are refused before anything is written" {
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  gate_issue
  base=$(git -C "$MC_HOME" rev-parse HEAD)
  try() {
    issue_commit "$1"
    run "$check" runbook push 9 --plan </dev/null
    echo "$output"
    [ "$status" -eq 2 ]
    [[ $output == *"$2"* ]] || { echo "want: $2"; false; }
    git -C "$MC_HOME" reset -q --hard "$base"
  }
  mkdir -p "$MC_HOME/server/plugins/Eco/logs"
  echo log >"$MC_HOME/server/plugins/Eco/logs/today.log"
  try 'a log' 'sync-rules skip logs/ covers server/plugins/Eco/logs/today.log'
  echo part >"$MC_HOME/server/plugins/Eco/up.yml.partial"
  try 'a partial' 'sync-rules skip *.partial covers server/plugins/Eco/up.yml.partial'
  echo db >"$MC_HOME/server/plugins/Eco/data.db"
  try 'a db' 'sync-rules data *.db covers server/plugins/Eco/data.db'
  ln -s /etc/passwd "$MC_HOME/server/plugins/Eco/link.yml"
  try 'a symlink' 'server/plugins/Eco/link.yml is not a regular file on both sides (mode 000000 -> 120000'
  rm "$MC_HOME/server/plugins/Eco/b.yml"
  ln -s a.yml "$MC_HOME/server/plugins/Eco/b.yml"
  try 'a typechange' 'server/plugins/Eco/b.yml is not a regular file on both sides (mode 100644 -> 120000'
  echo x >"$MC_HOME/server/plugins/Eco/-rf.yml"
  try 'a dash name' 'server/plugins/Eco/-rf.yml: a name starting with - or holding a newline is never pushed'
  echo x >"$MC_HOME/server/plugins/Eco/two"$'\n'"lines.yml"
  try 'a newline name' 'server/plugins/Eco/two\nlines.yml: a name starting with - or holding a newline is never pushed'
  [ "$(live 'cat plugins/Eco/b.yml')" = 'b: 1' ]
  live 'test ! -e plugins/Eco/link.yml && test ! -e plugins/Eco/logs && test ! -e plugins/Eco/data.db'
  [ ! -e "$MC_HOME/.dev/runbook-9/journal.jsonl" ]
}

@test "rollback restores binary and CRLF files byte for byte" {
  printf 'a\r\nb\r\n' >"$BATS_TEST_TMPDIR/crlf"
  head -c 4096 /dev/urandom >"$BATS_TEST_TMPDIR/bin"
  printf '\0\r\n\377' >>"$BATS_TEST_TMPDIR/bin"
  docker cp -q "$BATS_TEST_TMPDIR/crlf" "$SFTP_CONTAINER:/home/mc/plugins/Eco/crlf.yml"
  docker cp -q "$BATS_TEST_TMPDIR/bin" "$SFTP_CONTAINER:/home/mc/plugins/Eco/blob.dat"
  docker exec "$SFTP_CONTAINER" chown "$SFTP_UID" /home/mc/plugins/Eco/crlf.yml /home/mc/plugins/Eco/blob.dat
  git -C "$MC_HOME" switch -q main
  cp "$BATS_TEST_TMPDIR/crlf" "$MC_HOME/server/plugins/Eco/crlf.yml"
  cp "$BATS_TEST_TMPDIR/bin" "$MC_HOME/server/plugins/Eco/blob.dat"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'live drift: 2 files'
  git -C "$MC_HOME" switch -q issue/9
  git -C "$MC_HOME" merge -q --no-edit main
  printf 'x\r\ny\r\n' >"$MC_HOME/server/plugins/Eco/crlf.yml"
  head -c 2048 /dev/urandom >"$MC_HOME/server/plugins/Eco/blob.dat"
  printf 'rate: 2\n' >"$MC_HOME/server/plugins/Eco/config.yml"
  gate_issue
  run "$check" runbook push 9 </dev/null
  echo "$output"
  [ "$status" -eq 0 ]
  sum() { docker exec "$SFTP_CONTAINER" sha256sum "/home/mc/plugins/Eco/$1" | cut -d' ' -f1; }
  [ "$(sum blob.dat)" = "$(sha256sum <"$MC_HOME/server/plugins/Eco/blob.dat" | cut -d' ' -f1)" ]
  run "$check" runbook rollback 9 </dev/null
  [ "$status" -eq 0 ]
  grep -v '^#' <<<"$output" >"$BATS_TEST_TMPDIR/rollback.sh"
  bash -e "$BATS_TEST_TMPDIR/rollback.sh"
  [ "$(sum crlf.yml)" = "$(sha256sum <"$BATS_TEST_TMPDIR/crlf" | cut -d' ' -f1)" ]
  [ "$(sum blob.dat)" = "$(sha256sum <"$BATS_TEST_TMPDIR/bin" | cut -d' ' -f1)" ]
}

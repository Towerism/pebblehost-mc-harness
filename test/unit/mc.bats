# Unit tests for bin/mc against a fake rclone (test/unit/stub/rclone).

bats_require_minimum_version 1.5.0

setup() {
  export MC_HOME=$BATS_TEST_TMPDIR STUB_LOG=$BATS_TEST_TMPDIR/log STUB_ENV=$BATS_TEST_TMPDIR/env STUB_LSF=$BATS_TEST_TMPDIR/lsf STUB_OBSCURED=$BATS_TEST_TMPDIR/obscured
  PATH=$BATS_TEST_DIRNAME/stub:$PATH
  mc=$BATS_TEST_DIRNAME/../../bin/mc
  cat >"$MC_HOME/.env" <<'ENV'
# comment
PEBBLE_PANEL_EMAIL=me@example.com
PEBBLE_SFTP_HOST=node.example.net
export PEBBLE_SFTP_USER="me.abcd1234"
PEBBLE_PANEL_PASSWORD='pa$$ "word"'
PEBBLE_SERVER_NAME=Survive Papitas
ENV
}

@test "missing .env is reported" {
  rm "$MC_HOME/.env"
  run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"missing $MC_HOME/.env"* ]]
}

@test "missing required variables are named" {
  echo PEBBLE_SFTP_HOST=h >"$MC_HOME/.env"
  run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"PEBBLE_SFTP_USER PEBBLE_PANEL_PASSWORD"* ]]
}

@test "password with \$ and quotes reaches rclone obscure literally" {
  run "$mc" ls
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_OBSCURED")" = 'pa$$ "word"' ]
}

@test "unquoted values end at a space-led comment; quoted values keep #" {
  cat >"$MC_HOME/.env" <<'ENV'
PEBBLE_SFTP_HOST=node.example.net   # from the panel
PEBBLE_SFTP_USER=me.abcd1234 # user
PEBBLE_PANEL_PASSWORD="se#cret # x" # quoted
ENV
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=node.example.net' "$STUB_ENV"
  grep -qx 'RCLONE_CONFIG_PEBBLE_USER=me.abcd1234' "$STUB_ENV"
  [ "$(cat "$STUB_OBSCURED")" = 'se#cret # x' ]
}

@test "host given as sftp://host:port supplies the port" {
  sed -i 's#^PEBBLE_SFTP_HOST=.*#PEBBLE_SFTP_HOST=sftp://node.example.net:2222#' "$MC_HOME/.env"
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=node.example.net' "$STUB_ENV"
  grep -qx 'RCLONE_CONFIG_PEBBLE_PORT=2222' "$STUB_ENV"
}

@test "PEBBLE_SFTP_PORT wins over a port in the host" {
  printf 'PEBBLE_SFTP_HOST=node.example.net:2222\nPEBBLE_SFTP_PORT=2022\n' >>"$MC_HOME/.env"
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_PORT=2022' "$STUB_ENV"
}

@test "CRLF line endings in .env are tolerated" {
  sed -i 's/$/\r/' "$MC_HOME/.env"
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=node.example.net' "$STUB_ENV"
  [ "$(cat "$STUB_OBSCURED")" = 'pa$$ "word"' ]
}

@test "PEBBLE_ variables from the shell neither fill .env gaps nor reach rclone" {
  sed -i '/PEBBLE_SFTP_USER/d' "$MC_HOME/.env"
  PEBBLE_SFTP_USER=from-shell run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"PEBBLE_SFTP_USER"* ]]
  PEBBLE_SFTP_USER=x run "$mc" ls
  run ! grep -q '^PEBBLE_' "$STUB_ENV"
}

@test "diff on the server root needs --all" {
  run "$mc" diff
  [ "$status" -eq 2 ]
  [[ $output == *"diff on the server root needs --all"* ]]
  [ ! -e "$STUB_LOG" ]
}

@test "pull moves unpushed local edits to backups before replacing them" {
  "$mc" pull plugins/a.yml
  echo edited >"$MC_HOME/server/plugins/a.yml"
  run "$mc" pull plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"moved unpushed local edits"* ]]
  [ "$(cat "$MC_HOME"/backups/*/local/plugins/a.yml)" = edited ]
  [ "$(cat "$MC_HOME/server/plugins/a.yml")" = remote ]
}

@test "re-pull without local edits makes no backup" {
  "$mc" pull plugins/a.yml
  run "$mc" pull plugins/a.yml
  [ "$status" -eq 0 ]
  [ ! -e "$MC_HOME/backups" ]
}

@test ".env maps to rclone remote variables with default port" {
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=node.example.net' "$STUB_ENV"
  grep -qx 'RCLONE_CONFIG_PEBBLE_USER=me.abcd1234' "$STUB_ENV"
  grep -qx 'RCLONE_CONFIG_PEBBLE_PORT=2022' "$STUB_ENV"
  grep -qx 'RCLONE_CONFIG_PEBBLE_PASS=OBSCURED' "$STUB_ENV"
  grep -qx 'rclone lsf pebble:' "$STUB_LOG"
}

@test "password never reaches output, argv or written files" {
  run "$mc" pull plugins/x.yml
  [ "$status" -eq 0 ]
  [[ $output != *'pa$$'* ]]
  run ! grep -rqF 'pa$$' --exclude=.env --exclude=obscured "$MC_HOME"
}

@test "absolute paths are rejected" {
  run "$mc" pull /etc/passwd
  [ "$status" -eq 2 ]
  [[ $output == *"relative to the server root"* ]]
  [ ! -e "$STUB_LOG" ]
}

@test "paths with .. are rejected" {
  for p in .. ../x a/../../x a/..; do
    run "$mc" pull "$p"
    [ "$status" -eq 2 ]
    [[ $output == *"must not contain '..'"* ]]
  done
}

@test "leading ./ and trailing / are normalized" {
  run "$mc" pull ./plugins/Crates/
  [ "$status" -eq 0 ]
  grep -qx 'rclone copyto --ignore-times pebble:plugins/Crates '"$MC_HOME"'/server/plugins/Crates' "$STUB_LOG"
}

@test "pull of the server root is refused" {
  run "$mc" pull .
  [ "$status" -eq 2 ]
  [[ $output == *"pull on the server root needs --all"* ]]
}

@test "push of the server root needs --all" {
  run "$mc" push
  [ "$status" -eq 2 ]
  [[ $output == *"push on the server root needs --all"* ]]
}

@test "push without a recorded pull is refused" {
  mkdir -p "$MC_HOME/server/plugins" && echo x >"$MC_HOME/server/plugins/a.yml"
  run "$mc" push plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"pull it first"* ]]
}

@test "push refuses when the remote listing changed since pull" {
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  echo 'a.yml|11|2026-01-01 00:00:05' >"$STUB_LSF"
  run "$mc" push plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"changed since the last pull"* ]]
  run ! grep -q -- "$MC_HOME/server/plugins/a.yml pebble:plugins/a.yml" "$STUB_LOG"
}

@test "push backs up the remote copy before uploading" {
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  backup_line=$(grep -n "copyto pebble:plugins/a.yml $MC_HOME/backups/" "$STUB_LOG" | cut -d: -f1)
  upload_line=$(grep -n "copyto --inplace --ignore-times $MC_HOME/server/plugins/a.yml pebble:plugins/a.yml" "$STUB_LOG" | cut -d: -f1)
  [ -n "$backup_line" ] && [ -n "$upload_line" ] && [ "$backup_line" -lt "$upload_line" ]
}

# PebbleHost's SFTP server refuses rclone's rename of a .partial upload over the target.
@test "push uploads in place; downloads stay atomic" {
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  "$mc" diff plugins/a.yml || true
  run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  [ "$(grep -c -- '--inplace' "$STUB_LOG")" -eq 1 ]
  grep -qx "rclone copyto --inplace --ignore-times $MC_HOME/server/plugins/a.yml pebble:plugins/a.yml" "$STUB_LOG"
}

@test "unknown command prints usage" {
  run "$mc" frobnicate
  [ "$status" -eq 2 ]
  [[ $output == *"usage: mc"* ]]
}

# A fresh repo at $main (symlinks resolved, as git reports paths); never the repo running the tests.
make_repo() {
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR
  main=$(cd "$BATS_TEST_TMPDIR" && pwd -P)/main
  git init -q "$@" "$main"
  git -C "$main" -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit -q --allow-empty -m init
}

# A linked worktree of a fresh repo; MC_HOME points at the worktree and .env moves to the main checkout.
make_worktree() {
  make_repo
  git -C "$main" worktree add -q "$BATS_TEST_TMPDIR/wt"
  mv "$MC_HOME/.env" "$main/.env"
  export MC_HOME=$BATS_TEST_TMPDIR/wt
}

@test "a worktree with no .env anywhere names the main checkout's .env" {
  make_worktree
  rm "$main/.env"
  run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"missing $main/.env"* ]]
}

@test "MC_ENV_FILE wins over the main checkout's .env, even when it is missing" {
  make_worktree
  printf 'PEBBLE_SFTP_HOST=other.example.net\nPEBBLE_SFTP_USER=u\nPEBBLE_PANEL_PASSWORD=p\n' >"$BATS_TEST_TMPDIR/other.env"
  MC_ENV_FILE=$BATS_TEST_TMPDIR/other.env run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=other.example.net' "$STUB_ENV"
  MC_ENV_FILE=$BATS_TEST_TMPDIR/none.env run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"missing $BATS_TEST_TMPDIR/none.env"* ]]
}

@test "a pull from a worktree stashes local edits in the main checkout's backups/" {
  make_worktree
  "$mc" pull plugins/a.yml
  echo edited >"$MC_HOME/server/plugins/a.yml"
  run "$mc" pull plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"moved unpushed local edits to $main/backups/"* ]]
  [ "$(cat "$main"/backups/*/local/plugins/a.yml)" = edited ]
}

@test "a subdirectory of a worktree is not treated as a worktree" {
  make_worktree
  mkdir "$MC_HOME/sub"
  export MC_HOME=$MC_HOME/sub
  run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"missing $MC_HOME/.env"* ]]
}

@test "a worktree of a bare repo is not treated as a worktree" {
  make_repo
  git clone -q --bare "$main" "$BATS_TEST_TMPDIR/bare.git"
  git -C "$BATS_TEST_TMPDIR/bare.git" worktree add -q "$BATS_TEST_TMPDIR/wt"
  mv "$MC_HOME/.env" "$BATS_TEST_TMPDIR/wt/.env"
  export MC_HOME=$BATS_TEST_TMPDIR/wt
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"previous remote copy in backups/"* ]]
}

@test "a main checkout keeps backups under MC_HOME" {
  make_repo
  mv "$MC_HOME/.env" "$main/.env"
  export MC_HOME=$main
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"previous remote copy in backups/"* ]]
}

@test "without git, a worktree keeps backups under MC_HOME" {
  make_worktree
  mv "$main/.env" "$MC_HOME/.env"
  nogit=$BATS_TEST_TMPDIR/nogit
  mkdir "$nogit"
  # One ln for every binary (a loop forks thousands of times), then drop git.
  ln -sf /usr/bin/* /bin/* "$nogit/"
  rm -f "$nogit/git"
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  PATH=$BATS_TEST_DIRNAME/stub:$nogit "$mc" pull plugins/a.yml
  PATH=$BATS_TEST_DIRNAME/stub:$nogit run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"previous remote copy in backups/"* ]]
  [ ! -e "$main/backups" ]
}

@test "a backup directory that cannot be created stops push with exit 2 before uploading" {
  make_worktree
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  echo blocker >"$main/backups"
  run "$mc" push plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"cannot create a backup in $main/backups"* ]]
  run ! grep -q -- "--inplace" "$STUB_LOG"
}

@test "a worktree without .env uses the main checkout's .env" {
  make_worktree
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=node.example.net' "$STUB_ENV"
}

@test "a worktree's own .env and MC_ENV_FILE win over the main checkout's" {
  make_worktree
  printf 'PEBBLE_SFTP_HOST=wt.example.net\nPEBBLE_SFTP_USER=u\nPEBBLE_PANEL_PASSWORD=p\n' >"$MC_HOME/.env"
  run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=wt.example.net' "$STUB_ENV"
  printf 'PEBBLE_SFTP_HOST=other.example.net\nPEBBLE_SFTP_USER=u\nPEBBLE_PANEL_PASSWORD=p\n' >"$BATS_TEST_TMPDIR/other.env"
  MC_ENV_FILE=$BATS_TEST_TMPDIR/other.env run "$mc" ls
  [ "$status" -eq 0 ]
  grep -qx 'RCLONE_CONFIG_PEBBLE_HOST=other.example.net' "$STUB_ENV"
}

@test "a push from a worktree backs up into the main checkout; the mirror stays in the worktree" {
  make_worktree
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  [ "$(cat "$MC_HOME/server/plugins/a.yml")" = remote ]
  [ ! -e "$main/server" ]
  run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"previous remote copy in $main/backups/"* ]]
  [ "$(cat "$main"/backups/*/remote/plugins/a.yml)" = remote ]
  [ ! -e "$MC_HOME/backups" ]
}

@test "outside a worktree, backups stay under MC_HOME" {
  echo 'a.yml|10|2026-01-01 00:00:00' >"$STUB_LSF"
  "$mc" pull plugins/a.yml
  run "$mc" push plugins/a.yml
  [ "$status" -eq 0 ]
  [[ $output == *"previous remote copy in backups/"* ]]
}

@test "ls -l shows size and modtime; directories show - for size" {
  printf '%s\n' '-1|2026-11-01 09:12:40|ExcellentEconomy/' '173814|2026-10-30 18:01:02|ExcellentEconomy-2.8.0.jar' '5|2026-10-30 18:01:02|a|b.yml' >"$STUB_LSF"
  run "$mc" ls plugins -l
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = '           -  2026-11-01 09:12:40  ExcellentEconomy/' ]
  [ "${lines[1]}" = '      173814  2026-10-30 18:01:02  ExcellentEconomy-2.8.0.jar' ]
  [ "${lines[2]}" = '           5  2026-10-30 18:01:02  a|b.yml' ]
  grep -qx "rclone lsf --format stp --separator | pebble:plugins" "$STUB_LOG"
  run "$mc" ls --long plugins
  [ "$status" -eq 0 ]
}

@test "plain ls prints rclone's names unchanged" {
  printf '%s\n' 'ExcellentEconomy/' 'ExcellentEconomy-2.8.0.jar' >"$STUB_LSF"
  run "$mc" ls plugins
  [ "$status" -eq 0 ]
  [ "$output" = $'ExcellentEconomy/\nExcellentEconomy-2.8.0.jar' ]
  grep -qx "rclone lsf pebble:plugins" "$STUB_LOG"
}

@test "-l with pull, diff or push is refused" {
  for c in pull diff push; do
    run "$mc" "$c" plugins/a.yml -l
    [ "$status" -eq 2 ]
    [[ $output == *"-l and -R work only with ls"* ]]
  done
  [ ! -e "$STUB_LOG" ]
}

@test "MC_EXCLUDE_FILE reaches every listing and transfer as --exclude-from" {
  printf 'logs/**\n*.db\n' >"$BATS_TEST_TMPDIR/excl"
  export MC_EXCLUDE_FILE=$BATS_TEST_TMPDIR/excl
  run "$mc" ls plugins
  [ "$status" -eq 0 ]
  run "$mc" pull plugins
  [ "$status" -eq 0 ]
  run "$mc" diff plugins
  [ "$(grep -c "^rclone lsf .*--exclude-from $MC_EXCLUDE_FILE" "$STUB_LOG")" -ge 2 ]
  [ "$(grep -c "^rclone copyto .*--exclude-from $MC_EXCLUDE_FILE" "$STUB_LOG")" -eq 2 ]
  export MC_EXCLUDE_FILE=$BATS_TEST_TMPDIR/missing
  run "$mc" ls plugins
  [ "$status" -eq 2 ]
  [[ $output == *"MC_EXCLUDE_FILE $BATS_TEST_TMPDIR/missing not found"* ]]
}

@test "without MC_EXCLUDE_FILE no filter is passed" {
  run "$mc" pull plugins
  [ "$status" -eq 0 ]
  run ! grep -q -- '--exclude-from' "$STUB_LOG"
}

@test "ls -R lists every file below; -R works only with ls" {
  run "$mc" ls -R -l plugins
  [ "$status" -eq 0 ]
  grep -q '^rclone lsf -R --files-only --format stp' "$STUB_LOG"
  run "$mc" pull plugins -R
  [ "$status" -eq 2 ]
  [[ $output == *"-l and -R work only with ls"* ]]
}

@test "MC_FILTER_FILE reaches listings as --filter-from" {
  printf -- '+ /plugins/**\n- **\n' >"$BATS_TEST_TMPDIR/filter"
  MC_FILTER_FILE=$BATS_TEST_TMPDIR/filter run "$mc" ls -R -l
  [ "$status" -eq 0 ]
  grep -q "^rclone lsf -R --files-only --format stp --separator | --filter-from $BATS_TEST_TMPDIR/filter pebble:$" "$STUB_LOG"
  MC_FILTER_FILE=$BATS_TEST_TMPDIR/missing run "$mc" ls
  [ "$status" -eq 2 ]
  [[ $output == *"MC_FILTER_FILE $BATS_TEST_TMPDIR/missing not found"* ]]
}

@test "fetch copies the paths on stdin into server/ and records nothing; paths leaving the root are refused" {
  run "$mc" fetch <<<$'plugins/a.yml\nplugins/B/c.yml'
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'fetched 2 files -> server/'* ]]
  grep -q '^rclone copy --files-from-raw .* --no-traverse --ignore-times pebble: '"$MC_HOME/server"'$' "$STUB_LOG"
  [ ! -e "$MC_HOME/.mc" ]
  for bad in '../x' 'plugins/../../x' '/etc/passwd'; do
    run "$mc" fetch <<<"$bad"
    [ "$status" -eq 2 ]
    [[ $output == *"fetch: $bad leaves the server root"* ]]
  done
  run "$mc" fetch plugins </dev/null
  [ "$status" -eq 2 ]
  [[ $output == *"fetch takes its paths on stdin"* ]]
}

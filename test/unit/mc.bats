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
  run ! grep -q "copyto --inplace --ignore-times $MC_HOME/server" "$STUB_LOG"
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

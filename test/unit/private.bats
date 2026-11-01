# Unit tests for the private server repo rails: the MC_RUNBOOK guard in
# bin/mc, the template's root wrappers, hooks/private-pre-push and the
# template Makefile's hook check. Fake rclone (test/unit/stub/rclone).

bats_require_minimum_version 1.5.0

setup() {
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 STUB_LOG=$BATS_TEST_TMPDIR/log STUB_ENV=$BATS_TEST_TMPDIR/env STUB_LSF=$BATS_TEST_TMPDIR/lsf STUB_OBSCURED=$BATS_TEST_TMPDIR/obscured
  PATH=$BATS_TEST_DIRNAME/stub:$PATH
  harness=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  envfile=$BATS_TEST_TMPDIR/test.env
  printf 'PEBBLE_SFTP_HOST=h\nPEBBLE_SFTP_USER=u\nPEBBLE_PANEL_PASSWORD=p\n' >"$envfile"
}

# A private repo with the template copied in and harness/ a real submodule
# holding this checkout's bin/mc.
private_repo() {
  sub=$BATS_TEST_TMPDIR/harness-src
  mkdir -p "$sub/bin"
  cp "$harness/bin/mc" "$sub/bin/mc"
  git -C "$sub" init -q -b main
  git -C "$sub" add -A
  git -C "$sub" -c user.name=t -c user.email=t@e commit -q -m harness
  root=$BATS_TEST_TMPDIR/private
  git init -q -b main "$root"
  git -C "$root" -c protocol.file.allow=always submodule add -q "$sub" harness 2>/dev/null
  cp -r "$harness/template/." "$root/"
}

@test "harness/bin/mc as a submodule of a .harness-private repo refuses push without MC_RUNBOOK=1" {
  private_repo
  home=$BATS_TEST_TMPDIR/home
  mkdir -p "$home"
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$root/harness/bin/mc" push plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"live writes go through bin/check runbook push N"* ]]
  [ ! -e "$STUB_LOG" ]
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" MC_RUNBOOK=1 "$root/harness/bin/mc" push plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"server/plugins/a.yml not found; pull it first"* ]]
  # ls, pull and diff are not guarded.
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$root/harness/bin/mc" ls
  [ "$status" -eq 0 ]
}

@test "bin/mc refuses push when MC_HOME holds .harness-private, and not elsewhere" {
  home=$BATS_TEST_TMPDIR/home
  mkdir -p "$home/server"
  echo x >"$home/server/a.yml"
  touch "$home/.harness-private"
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$harness/bin/mc" push a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"runbook push"* ]]
  rm "$home/.harness-private"
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$harness/bin/mc" push a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"no pull recorded for 'a.yml'"* ]]
}

@test "the template's root bin/mc refuses pull and fetch outside .dev/, passes ls and .dev pulls through, and push hits the guard" {
  private_repo
  run env MC_ENV_FILE="$envfile" "$root/bin/mc" pull plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"pull is refused here"* ]]
  run env MC_HOME="$root/.dev/../server" MC_ENV_FILE="$envfile" "$root/bin/mc" pull plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"pull is refused here"* ]]
  run env MC_ENV_FILE="$envfile" "$root/bin/mc" fetch <<<plugins/a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"fetch is refused here"* ]]
  [ ! -e "$STUB_LOG" ]
  run env MC_ENV_FILE="$envfile" "$root/bin/mc" ls plugins
  [ "$status" -eq 0 ]
  grep -qx 'rclone lsf pebble:plugins' "$STUB_LOG"
  run env MC_HOME="$root/.dev/seed-1/home" MC_ENV_FILE="$envfile" "$root/bin/mc" pull plugins/a.yml
  [ "$status" -eq 0 ]
  [ -e "$root/.dev/seed-1/home/server/plugins/a.yml" ]
  mkdir -p "$root/server"
  echo x >"$root/server/a.yml"
  run env MC_ENV_FILE="$envfile" "$root/bin/mc" push a.yml
  [ "$status" -eq 2 ]
  [[ $output == *"runbook push"* ]]
}

@test "the template's bin/dev and bin/check run the harness on the repo root and its .env" {
  root=$BATS_TEST_TMPDIR/private
  mkdir -p "$root/harness/bin"
  cp -r "$harness/template/bin" "$root/"
  for t in dev check; do
    printf '#!/usr/bin/env bash\necho "%s MC_HOME=$MC_HOME MC_ENV_FILE=$MC_ENV_FILE $*"\n' "$t" >"$root/harness/bin/$t"
    chmod +x "$root/harness/bin/$t"
  done
  run env -u MC_ENV_FILE MC_HOME=/elsewhere "$root/bin/dev" status
  [ "$output" = "dev MC_HOME=$root MC_ENV_FILE=$root/.env status" ]
  run env -u MC_ENV_FILE "$root/bin/check" suite
  [ "$output" = "check MC_HOME=$root MC_ENV_FILE=$root/.env suite" ]
}

@test "private-pre-push allows only the Gitea host" {
  for url in ssh://git@vcs.martinfrackerjr.com:2222/m/s.git git@vcs.martinfrackerjr.com:m/s.git https://VCS.martinfrackerjr.com/m/s.git; do
    run "$harness/hooks/private-pre-push" origin "$url" </dev/null
    [ "$status" -eq 0 ] || { echo "$url"; false; }
  done
  for url in git@github.com:Towerism/survive.git https://github.com/a/b.git /srv/git/s.git file:///srv/git/s.git https://vcs.martinfrackerjr.com.evil.example/x https://vcs.martinfrackerjr.com@evil.example/x 'https://github.com\@vcs.martinfrackerjr.com/x' 'https://vcs.martinfrackerjr.com@github.com/x' 'https://a@b@vcs.martinfrackerjr.com/x' 'ssh://vcs.martinfrackerjr.com\@github.com/x' 'vcs.martinfrackerjr.com\:x' ''; do
    run "$harness/hooks/private-pre-push" gh "$url" </dev/null
    [ "$status" -eq 2 ] || { echo "$url"; false; }
    [[ $output == *"is not on vcs.martinfrackerjr.com"* ]]
  done
}

@test "the template's make test refuses while either hook is missing" {
  private_repo
  run make -s -C "$root" test
  [ "$status" -ne 0 ]
  [[ $output == *"this repo's pre-push hook is not installed; run make hooks"* ]]
  ln -s "$root/harness/hooks/private-pre-push" "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/hooks/pre-push"
  run make -s -C "$root" test
  [ "$status" -ne 0 ]
  [[ $output == *"the harness submodule's path-guard hooks are not installed"* ]]
}

@test "bin/mc takes a path starting with - after --, and only one" {
  home=$BATS_TEST_TMPDIR/home
  mkdir -p "$home"
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$harness/bin/mc" pull -x.yml
  [ "$status" -eq 2 ]
  [[ $output == *"unknown option: -x.yml"* ]]
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$harness/bin/mc" pull -- -x.yml
  [ "$status" -eq 0 ]
  grep -q 'copyto --ignore-times pebble:-x.yml ' "$STUB_LOG"
  [ -e "$home/server/-x.yml" ]
  run env MC_HOME="$home" MC_ENV_FILE="$envfile" "$harness/bin/mc" pull -- a b
  [ "$status" -eq 2 ]
  [[ $output == *"one path at a time"* ]]
}

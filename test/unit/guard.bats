# Unit tests for the path guard's hooks (hooks/, bin/path-guard) in a temp git repo.
# Fixtures are generated here; nothing under server/ is ever committed to this repo.

bats_require_minimum_version 1.5.0

setup() {
  hooks=$(cd "$BATS_TEST_DIRNAME/../../hooks" && pwd)
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  repo=$BATS_TEST_TMPDIR/repo
  git init -q -b main "$repo"
  cd "$repo"
  git config user.name test
  git config user.email test@example.com
  git config core.hooksPath "$hooks"
  echo '# repo' >README.md
  git add README.md
  git commit -q -m init
}

@test "pre-commit refuses a staged server file with exit 2" {
  mkdir server
  echo 'motd: hi' >server/x.yml
  git add server/x.yml
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"server/x.yml: denied: server/"* ]]
  run ! git commit -q -m leak
  [ -z "$(git log --format=%s -1 | grep leak)" ]
}

@test "pre-commit lists every offending path" {
  mkdir -p plugins/X test
  echo a >plugins/X/config.yml
  echo b >test/server.jar
  echo c >secret.txt
  git add -A
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"refused 3 path(s)"* ]]
  [[ $output == *"plugins/X/config.yml: denied: plugins/"* ]]
  [[ $output == *"test/server.jar: denied: *.jar*"* ]]
  [[ $output == *"secret.txt: not in the public allowlist"* ]]
}

@test "pre-commit lets an allowed file through" {
  mkdir bin
  echo 'echo hi' >bin/tool
  git add bin/tool
  run "$hooks/pre-commit"
  [ "$status" -eq 0 ]
  git commit -q -m tool
  [ "$(git log --format=%s -1)" = tool ]
}

@test "pre-commit ignores a staged deletion" {
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m old
  git rm -q server/x.yml
  run "$hooks/pre-commit"
  [ "$status" -eq 0 ]
}

@test "pre-commit refuses a file one byte over 512 KB, passes one at the cap" {
  mkdir docs
  head -c $((512 * 1024)) /dev/zero >docs/ok.bin
  git add docs/ok.bin
  run "$hooks/pre-commit"
  [ "$status" -eq 0 ]
  head -c $((512 * 1024 + 1)) /dev/zero >docs/big.bin
  git add docs/big.bin
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/big.bin: 524289 bytes, over the 524288-byte cap"* ]]
  [[ $output != *"docs/ok.bin"* ]]
}

@test "--range refuses a server file added then removed inside the range" {
  base=$(git rev-parse HEAD)
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m leak
  git rm -q server/x.yml
  git commit -q -m unleak
  run bin_guard --range "$base..HEAD"
  [ "$status" -eq 2 ]
  [[ $output == *"server/x.yml: denied: server/"* ]]
}

@test "--profile private allows server files and refuses player data" {
  mkdir -p server/plugins/Essentials/userdata
  echo a >server/server.properties
  echo b >server/plugins/Essentials/userdata/u.yml
  git add -A
  run bin_guard --staged --profile private
  [ "$status" -eq 2 ]
  [[ $output == *"server/plugins/Essentials/userdata/u.yml: denied: userdata/"* ]]
  [[ $output != *"server.properties"* ]]
}

@test "bad arguments exit 2 with usage" {
  run bin_guard --range main
  [ "$status" -eq 2 ]
  run bin_guard
  [ "$status" -eq 2 ]
  [[ $output == *"usage: path-guard"* ]]
}

@test "pre-push compares a new branch with origin/main" {
  git init -q --bare "$BATS_TEST_TMPDIR/origin.git"
  git remote add origin "$BATS_TEST_TMPDIR/origin.git"
  git push -q --no-verify origin main
  git switch -q -c feature
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m leak
  run "$hooks/pre-push" origin url <<<"refs/heads/feature $(git rev-parse HEAD) refs/heads/feature 0000000000000000000000000000000000000000"
  [ "$status" -eq 2 ]
  [[ $output == *"server/x.yml: denied: server/"* ]]
  run ! git push -q origin feature
  run ! git ls-remote --exit-code origin refs/heads/feature
}

@test "pre-push checks only commits the remote branch lacks" {
  git init -q --bare "$BATS_TEST_TMPDIR/origin.git"
  git remote add origin "$BATS_TEST_TMPDIR/origin.git"
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m old
  git push -q --no-verify origin main
  remote=$(git rev-parse HEAD)
  mkdir bin
  echo y >bin/tool
  git add bin/tool
  git commit -q -m tool
  run "$hooks/pre-push" origin url <<<"refs/heads/main $(git rev-parse HEAD) refs/heads/main $remote"
  [ "$status" -eq 0 ]
  git push -q origin main
}

@test "pre-push refuses without origin/main" {
  run "$hooks/pre-push" origin url <<<"refs/heads/main $(git rev-parse HEAD) refs/heads/main 0000000000000000000000000000000000000000"
  [ "$status" -eq 2 ]
  [[ $output == *"origin/main not found"* ]]
}

@test "pre-push ignores a branch deletion" {
  run "$hooks/pre-push" origin url <<<"(delete) 0000000000000000000000000000000000000000 refs/heads/gone $(git rev-parse HEAD)"
  [ "$status" -eq 0 ]
}

bin_guard() {
  "$hooks/../bin/path-guard" "$@"
}

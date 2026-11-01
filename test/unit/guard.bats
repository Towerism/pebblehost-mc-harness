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
  # The checkout's hooks/ (untracked) plus the stubs make hooks installs.
  ln -s "$hooks" hooks
  echo /hooks >>.git/info/exclude
  "$hooks/../bin/install-hooks" >/dev/null
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

@test "pre-commit matches deny rules in any case" {
  mkdir -p docs/Plugins test
  echo a >docs/Plugins/a.yml
  echo b >test/.ENV
  echo c >docs/foo.JAR
  git add -A
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/Plugins/a.yml: denied: plugins/"* ]]
  [[ $output == *"test/.ENV: denied: .env*"* ]]
  [[ $output == *"docs/foo.JAR: denied: *.jar*"* ]]
}

@test "pre-commit refuses a renamed copy of a local server, backup or .mc file" {
  mkdir -p server/luckperms backups/1/remote .mc test/fixtures
  printf 'storage-method: h2\n' >server/luckperms/config.yml
  printf 'motd: backup\n' >backups/1/remote/server.yml
  printf 'listing\n' >.mc/state
  cp server/luckperms/config.yml test/fixtures/lp.yml
  cp backups/1/remote/server.yml test/fixtures/b.yml
  cp .mc/state test/fixtures/state.txt
  git add test/fixtures
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"test/fixtures/lp.yml: identical to server file server/luckperms/config.yml"* ]]
  [[ $output == *"test/fixtures/b.yml: identical to server file backups/1/remote/server.yml"* ]]
  [[ $output == *"test/fixtures/state.txt: identical to server file .mc/state"* ]]
}

@test "pre-commit refuses a copy of a tracked server file gone from disk" {
  mkdir server docs
  printf 'secret: 1\n' >server/a.yml
  git add server/a.yml
  git commit -q --no-verify -m old
  rm -r server
  printf 'secret: 1\n' >docs/a.txt
  git add docs/a.txt
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/a.txt: identical to server file server/a.yml"* ]]
}

@test "in a linked worktree, a copy of the main checkout's backup is refused" {
  mkdir -p backups/1/remote
  printf 'motd: main\n' >backups/1/remote/server.yml
  git worktree add -q "$BATS_TEST_TMPDIR/wt"
  cd "$BATS_TEST_TMPDIR/wt"
  mkdir docs
  printf 'motd: main\n' >docs/m.yml
  git add docs/m.yml
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/m.yml: identical to server file $repo/backups/1/remote/server.yml"* ]]
}

@test "inside a submodule, a copy of the superproject's server file is refused" {
  super=$BATS_TEST_TMPDIR/super
  git init -q -b main "$super"
  mkdir "$super/server"
  printf 'db-password: x\n' >"$super/server/config.yml"
  git clone -q "$repo" "$super/harness"
  git -C "$super" add server harness 2>/dev/null
  git -C "$super" -c user.name=t -c user.email=t@e commit -q -m init
  rm -r "$super/server"
  cd "$super/harness"
  mkdir docs
  printf 'db-password: x\n' >docs/c.yml
  git add docs/c.yml
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/c.yml: identical to server file $super/server/config.yml"* ]]
}

@test "the empty file never counts as a server copy" {
  mkdir server docs
  : >server/empty.yml
  : >docs/.keep
  git add docs/.keep
  run "$hooks/pre-commit"
  [ "$status" -eq 0 ]
}

@test "symlinks are refused, staged or in a range" {
  base=$(git rev-parse HEAD)
  mkdir docs
  ln -s ../README.md docs/link
  git add docs/link
  run "$hooks/pre-commit"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/link: symlink"* ]]
  git commit -q --no-verify -m link
  run bin_guard --range "$base..HEAD"
  [ "$status" -eq 2 ]
  [[ $output == *"docs/link: symlink"* ]]
}

@test "--range and pre-push refuse ends that are not commits" {
  tree=$(git rev-parse HEAD^{tree})
  run bin_guard --range "HEAD..$tree"
  [ "$status" -eq 2 ]
  [[ $output == *"is not a commit"* ]]
  run bin_guard --range "nope..HEAD"
  [ "$status" -eq 2 ]
  run "$hooks/pre-push" origin url <<<"refs/tags/t $tree refs/tags/t 0000000000000000000000000000000000000000"
  [ "$status" -eq 2 ]
  [[ $output == *"$tree is not a commit"* ]]
}

@test "a replace ref cannot hide a leaking commit" {
  base=$(git rev-parse HEAD)
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m leak
  leak=$(git rev-parse HEAD)
  git reset -q --hard "$base"
  mkdir docs
  echo ok >docs/ok.md
  git add docs/ok.md
  git commit -q -m clean
  git replace "$leak" HEAD
  [ -z "$(git ls-tree -r --name-only "$leak" server)" ]
  run bin_guard --range "$base..$leak"
  [ "$status" -eq 2 ]
  [[ $output == *"server/x.yml: denied: server/"* ]]
}

@test "--history checks every commit reachable from a revision" {
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m leak
  git rm -q server/x.yml
  git commit -q -m unleak
  run bin_guard --history HEAD
  [ "$status" -eq 2 ]
  [[ $output == *"server/x.yml: denied: server/"* ]]
}

@test "pre-merge-commit refuses a merge that brings in a server file" {
  git switch -q -c side
  mkdir server
  echo x >server/x.yml
  git add server/x.yml
  git commit -q --no-verify -m leak
  git switch -q main
  echo more >>README.md
  git commit -q -am more
  run ! git merge -q --no-ff -m merge side
  [ "$(git log --format=%s -1)" = more ]
}

@test "a worktree without hooks/ refuses commits" {
  git worktree add -q "$BATS_TEST_TMPDIR/wt"
  cd "$BATS_TEST_TMPDIR/wt"
  [ ! -e hooks ]
  echo y >notes.md
  git add notes.md
  run git commit -q -m note
  [ "$status" -ne 0 ]
  [[ $output == *"path-guard hooks missing in this checkout"* ]]
}

@test "install-hooks unsets core.hooksPath=hooks and keeps foreign hooks" {
  git config core.hooksPath hooks
  "$hooks/../bin/install-hooks" >/dev/null
  run ! git config --get core.hooksPath
  echo '#!/bin/sh' >.git/hooks/pre-push
  run "$hooks/../bin/install-hooks"
  [ "$status" -eq 2 ]
  [[ $output == *"is not a path-guard stub"* ]]
  git config core.hooksPath elsewhere
  run "$hooks/../bin/install-hooks"
  [ "$status" -eq 2 ]
}

bin_guard() {
  "$hooks/../bin/path-guard" "$@"
}

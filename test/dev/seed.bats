# Dev tier: bin/dev seed end to end. An atmoz/sftp container stands in for
# live and serves the primed vanilla Purpur tree; seed syncs it to main, puts
# a project of its own on issue/N and boots a pod from it (AC 1). A re-seed
# leaves nothing of the old pod or its data behind (AC 2).

bats_require_minimum_version 1.5.0

setup_file() {
  primed=$("$BATS_TEST_DIRNAME/prime")
  export SEED_SFTP=mc-seed-$$ SFTP_UID=1001 SEED_PASS='seed pa$$'
  docker run -d --rm --name "$SEED_SFTP" -p 127.0.0.1::22 atmoz/sftp:alpine "mc:$SEED_PASS:$SFTP_UID:$SFTP_UID" >/dev/null
  SEED_PORT=$(docker port "$SEED_SFTP" 22/tcp | head -1 | sed 's/.*://')
  export SEED_PORT
  for _ in $(seq 50); do docker exec "$SEED_SFTP" pgrep sshd >/dev/null 2>&1 && (exec 3<>"/dev/tcp/127.0.0.1/$SEED_PORT") 2>/dev/null && break; sleep 0.2; done
  # The live tree: the primed server, its properties, a data file.
  for f in purpur.jar cache libraries versions; do docker cp -q "$primed/$f" "$SEED_SFTP:/home/mc/$f"; done
  docker exec "$SEED_SFTP" sh -c 'cd /home/mc && printf "eula=true\n" >eula.txt && printf "online-mode=true\nmotd=live\nlevel-type=minecraft\\\\:flat\ngenerate-structures=false\nview-distance=3\nsimulation-distance=3\n" >server.properties && printf "[{\"ip\":\"10.9.8.7\",\"created\":\"2026-01-01 00:00:00 +0000\",\"source\":\"seed\",\"expires\":\"forever\",\"reason\":\"test\"}]\n" >banned-ips.json && chown -R '"$SFTP_UID"' /home/mc/* && chmod 755 /home/mc'
  export MC_HOME=$BATS_FILE_TMPDIR/proj
  git init -q -b main "$MC_HOME"
  git -C "$MC_HOME" config user.name test
  git -C "$MC_HOME" config user.email test@example.com
  printf 'PEBBLE_SFTP_HOST=127.0.0.1\nPEBBLE_SFTP_PORT=%s\nPEBBLE_SFTP_USER=mc\nPEBBLE_PANEL_PASSWORD=%s\n' "$SEED_PORT" "'$SEED_PASS'" >"$MC_HOME/.env"
  printf '.env\n.dev/\n.mc/\n' >"$MC_HOME/.gitignore"
  git -C "$MC_HOME" add -A
  git -C "$MC_HOME" commit -q -m 'empty project'
  git -C "$MC_HOME" switch -q -c work
  SEED_PROJECT=$(printf %s "$(realpath "$MC_HOME")" | sha256sum | cut -c1-8)
  export SEED_PROJECT
}

teardown_file() {
  "$DEV" down --all </dev/null >/dev/null 2>&1 || true
  docker rm -f "$SEED_SFTP" >/dev/null 2>&1 || true
}

dev() {
  RCLONE_LOW_LEVEL_RETRIES=1 timeout 600 "$DEV" "$@" </dev/null
}

@test "seed N syncs live to main, cuts issue/N from it and boots a pod with the opt-in data as fixtures" {
  run dev seed 7 --with-data banned-ips.json
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *'committed "live drift: '*'" on main'* ]]
  [[ $output == *"seed: created issue/7"* && $output == *"up: pod dev done in"* ]]
  [ "$(git -C "$MC_HOME" symbolic-ref --short HEAD)" = issue/7 ]
  [ "$(git -C "$MC_HOME" show issue/7:server/server.properties | grep motd)" = motd=live ]
  s=mc-$SEED_PROJECT-dev-server
  [ "$(docker inspect --format '{{index .Config.Labels "mc-harness.commit"}}' "$s")" = "$(git -C "$MC_HOME" rev-parse issue/7)" ]
  docker exec "$s" grep -q 10.9.8.7 /server/banned-ips.json
  docker inspect --format '{{.Id}}' "$s" >"$BATS_FILE_TMPDIR/old-container"
  docker inspect --format '{{index .Config.Labels "mc-harness.generation"}}' "$s" >"$BATS_FILE_TMPDIR/old-generation"
}

@test "a re-seed keeps issue/N's commits and leaves nothing of the old pod or its data" {
  sed 's/^motd=.*/motd=fixed/' "$MC_HOME/server/server.properties" >"$MC_HOME/server/server.properties.new"
  mv "$MC_HOME/server/server.properties.new" "$MC_HOME/server/server.properties"
  git -C "$MC_HOME" commit -q -am 'fix on issue/7'
  run dev seed 7
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"seed: reused issue/7"* ]]
  s=mc-$SEED_PROJECT-dev-server
  run docker inspect "$(cat "$BATS_FILE_TMPDIR/old-container")"
  [ "$status" -ne 0 ]
  [ "$(docker inspect --format '{{index .Config.Labels "mc-harness.generation"}}' "$s")" != "$(cat "$BATS_FILE_TMPDIR/old-generation")" ]
  [ "$(docker ps -aq --filter "label=mc-harness.project=$SEED_PROJECT" | wc -l)" -eq 2 ]
  [ "$(docker volume ls -q --filter "label=mc-harness.project=$SEED_PROJECT" | wc -l)" -eq 1 ]
  [ ! -e "$MC_HOME/.dev/seed-7/home/server" ]
  run docker exec "$s" grep -q 10.9.8.7 /server/banned-ips.json
  [ "$status" -ne 0 ]
  docker exec "$s" grep -qx motd=fixed /server/server.properties
  run dev down --all
  [ "$status" -eq 0 ]
  [ -z "$(docker ps -aq --filter "label=mc-harness.project=$SEED_PROJECT")" ]
  [ -z "$(docker volume ls -q --filter "label=mc-harness.project=$SEED_PROJECT")" ]
  [ -z "$(docker network ls -q --filter "label=mc-harness.project=$SEED_PROJECT")" ]
  [ -z "$(docker image ls -q --filter "label=mc-harness.project=$SEED_PROJECT")" ]
}

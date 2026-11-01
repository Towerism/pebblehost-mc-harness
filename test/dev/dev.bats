# Dev tier: bin/dev against Docker and a vanilla Purpur server (setup_suite.bash).
# The tests share one pod and run in file order; each states what it expects
# from the ones before. Every bin/dev call has stdin closed and a hard timeout.

bats_require_minimum_version 1.5.0

dev() {
  timeout 300 "$DEV" "$@" </dev/null
}

label() {
  docker inspect --format "{{index .Config.Labels \"mc-harness.$1\"}}" "$SERVER"
}

@test "up refuses an uncommitted server/ change" {
  echo 'motd=dirty' >>"$MC_HOME/server/server.properties"
  run dev up
  git -C "$MC_HOME" checkout -q server
  [ "$status" -eq 2 ]
  [[ $output == *"server/ has uncommitted changes"* ]]
  [[ $output == *"server/server.properties"* ]]
}

@test "up boots offline to Done with fixtures applied and overrides baked in" {
  run dev up --fixtures "$FIXTURES"
  [ "$status" -eq 0 ]
  [[ $output == *"image: built mc-dev:"* ]]
  [[ $output == *"override: server.properties: online-mode=false"* ]]
  [[ $output == *"up: pod dev done in"* ]]
  [ "$(docker exec "$SERVER" cat /server/fixture.txt)" = 'from fixtures' ]
  docker exec "$SERVER" grep -qx 'online-mode=false' /server/server.properties
  docker exec "$SERVER" grep -qx 'enable-rcon=true' /server/server.properties
  [ "$(label source)" = archive ]
  [ "$(label commit)" = "$(git -C "$MC_HOME" rev-parse HEAD)" ]
  [ "$(label tree)" = "$(git -C "$MC_HOME" rev-parse HEAD:server)" ]
  [ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$SERVER")" = 4096 ]
  [ "$(stat -c %a "$MC_HOME/.dev")" = 700 ]
  [ "$(stat -c %a "$MC_HOME/.dev/pods/dev/pod.json")" = 600 ]
}

@test "the server has no default route, no egress, no DNS and nothing on 8192" {
  run docker exec -i "$SERVER" bash -s <"$BATS_TEST_DIRNAME/egress-probe"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"no ipv4 default route"* ]]
  [[ $output == *"ipv6 disabled"* || $output == *"no ipv6 default route"* ]]
  [ "$(docker network inspect --format '{{.EnableIPv6}}' "mc-$PROJECT-dev-net")" = false ]
  [ "$(docker network inspect --format '{{.Internal}}' "mc-$PROJECT-dev-net")" = true ]
  [[ $output == *"tcp 1.1.1.1:443 unreachable"* ]]
  [[ $output == *"example.com does not resolve"* ]]
  [[ $output == *"nothing on 8192"* ]]
  [ -z "$(docker port "$SERVER")" ]
}

@test "status and boot-report describe the running pod" {
  run dev status
  [ "$status" -eq 0 ]
  [[ $output == *"dev"*"running"*"$(git -C "$MC_HOME" rev-parse HEAD)"* ]]
  run dev boot-report
  [ "$status" -eq 0 ]
  [[ $output == *"done: "*"s"* ]]
  [[ $output == *"plugins failed: 0"* ]]
}

@test "up on an existing pod refuses" {
  run dev up
  [ "$status" -eq 2 ]
  [[ $output == *"pod dev already exists"* ]]
}

@test "restart keeps files and SQLite rows, and the labels keep the booted commit" {
  booted=$(git -C "$MC_HOME" rev-parse HEAD)
  docker exec "$SERVER" sh -c 'echo kept >/server/state.txt'
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("create table t (v text)"); db.prepare("insert into t values (?)").run("row"); db.close()' "$BATS_TEST_TMPDIR/state.db"
  docker cp -q "$BATS_TEST_TMPDIR/state.db" "$SERVER:/server/state.db"
  # A commit after boot: a restart must not claim it.
  sed -i 's/^motd=.*/motd=fixed/' "$MC_HOME/server/server.properties"
  git -C "$MC_HOME" commit -q -am 'motd fix'
  run dev restart
  [ "$status" -eq 0 ]
  [[ $output == *"restart: pod dev done in"* ]]
  [ "$(docker exec "$SERVER" cat /server/state.txt)" = kept ]
  docker cp -q "$SERVER:/server/state.db" "$BATS_TEST_TMPDIR/back.db"
  [ "$(node -e 'const { DatabaseSync } = require("node:sqlite"); console.log(new DatabaseSync(process.argv[1]).prepare("select v from t").get().v)' "$BATS_TEST_TMPDIR/back.db")" = row ]
  [ "$(label commit)" = "$booted" ]
  docker exec "$SERVER" grep -qx 'motd=vanilla' /server/server.properties
}

@test "reset re-applies the fixtures and keeps other state" {
  docker exec "$SERVER" sh -c 'echo changed >/server/fixture.txt'
  run dev reset
  [ "$status" -eq 0 ]
  [ "$(docker exec "$SERVER" cat /server/fixture.txt)" = 'from fixtures' ]
  [ "$(docker exec "$SERVER" cat /server/state.txt)" = kept ]
}

@test "rebuild refuses an uncommitted server/ change" {
  echo 'x' >"$MC_HOME/server/new.txt"
  run dev rebuild
  rm "$MC_HOME/server/new.txt"
  [ "$status" -eq 2 ]
  [[ $output == *"server/new.txt"* ]]
}

@test "a rebuild whose build fails leaves the old pod running" {
  booted=$(label commit)
  echo 'not a jar' >"$MC_HOME/server/extra.jar"
  git -C "$MC_HOME" add server
  git -C "$MC_HOME" commit -q -m 'second root jar'
  run dev rebuild
  git -C "$MC_HOME" reset -q --hard HEAD~1
  [ "$status" -eq 2 ]
  [[ $output == *"exactly one *.jar"* ]]
  [ "$(docker inspect --format '{{.State.Status}}' "$SERVER")" = running ]
  [ "$(label commit)" = "$booted" ]
  [ "$(docker exec "$SERVER" cat /server/state.txt)" = kept ]
}

@test "rebuild after a config-only commit reuses the jar layer and relabels" {
  run dev rebuild
  [ "$status" -eq 0 ]
  [[ $output == *"jar layer cached"* ]]
  [ "$(label commit)" = "$(git -C "$MC_HOME" rev-parse HEAD)" ]
  docker exec "$SERVER" grep -qx 'motd=fixed' /server/server.properties
  # A new volume: the old state is gone, the fixtures are back.
  run ! docker exec "$SERVER" test -e /server/state.txt
  [ "$(docker exec "$SERVER" cat /server/fixture.txt)" = 'from fixtures' ]
  # The image of the old commit is pruned; only the running one is left.
  [ "$(docker image ls -q --filter "label=mc-harness.project=$PROJECT" | sort -u | wc -l)" -eq 1 ]
}

@test "join proxies localhost through its own locked-down container; down --all removes everything labelled" {
  run dev join --port 25599
  [ "$status" -eq 0 ]
  [ "$(docker port "mc-$PROJECT-dev-join" 25565/tcp)" = '127.0.0.1:25599' ]
  timeout 5 bash -c '</dev/tcp/127.0.0.1/25599'
  join=mc-$PROJECT-dev-join
  [ "$(docker inspect --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' "$join")" = '65534:65534 true [ALL]' ]
  [ "$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$join" | tr ' ' '\n' | sort | xargs)" = "mc-$PROJECT-dev-joinnet mc-$PROJECT-dev-net" ]
  run dev down --all
  [ "$status" -eq 0 ]
  [ -z "$(docker ps -aq --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker volume ls -q --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker network ls -q --filter "label=mc-harness.project=$PROJECT")" ]
  [ -z "$(docker image ls -q --filter "label=mc-harness.project=$PROJECT")" ]
}

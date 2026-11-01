# Dev tier: bin/dev against Docker and a vanilla Purpur server (setup_suite.bash).
# The tests share one pod and run in file order; each states what it expects
# from the ones before. Every bin/dev call has stdin closed and a hard timeout.

bats_require_minimum_version 1.5.0

dev() {
  timeout 300 "$DEV" "$@" </dev/null
}

RELAY_LIST='There are 0 of a max of 20 players online: '

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
  [[ $output == *"override: 2 overridden file(s) verified in the image"* ]]
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
  # Update and metrics hosts are sunk to localhost, so calls fail at once.
  [ "$(docker exec "$SERVER" getent hosts bstats.org | cut -d' ' -f1)" = 127.0.0.1 ]
}

@test "the relay is locked down like the server and has no way out either" {
  relay=mc-$PROJECT-dev-relay
  [ "$(docker inspect --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Init}}' "$relay")" = '1000:1000 true [ALL] [no-new-privileges] true' ]
  [ "$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$relay" | xargs)" = "mc-$PROJECT-dev-net" ]
  [ -z "$(docker port "$relay")" ]
  # tini is PID 1, the daemon its child.
  [ "$(docker exec "$relay" cat /proc/1/cmdline | tr '\0' ' ')" = '/sbin/docker-init -- node /relay/daemon.ts ' ]
  # The pod's password reaches the relay through its environment, not argv.
  pw=$(docker exec "$relay" printenv RCON_PASSWORD)
  [ -n "$pw" ] && [ "$pw" = "$(docker exec "$SERVER" printenv RCON_PASSWORD)" ]
  # (`! cmd` would not fail a bats test; `false` in the branch does.)
  if docker inspect --format '{{.Path}} {{.Args}} {{.Config.Cmd}}' "$relay" | grep -qF -- "$pw"; then false; fi
  if docker exec "$relay" sh -c 'cat /proc/[0-9]*/cmdline' | grep -qF -- "$pw"; then false; fi
  run docker exec -i "$relay" bash -s <"$BATS_TEST_DIRNAME/egress-probe"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ $output == *"no ipv4 default route"* ]]
  [[ $output == *"ipv6 disabled"* || $output == *"no ipv6 default route"* ]]
  [[ $output == *"tcp 1.1.1.1:443 unreachable"* ]]
  [[ $output == *"example.com does not resolve"* ]]
}

@test "console prints the exact RCON reply, and a second CLI call reuses the relay's connection" {
  relay=mc-$PROJECT-dev-relay
  started=$(docker inspect --format '{{.State.StartedAt}}' "$relay")
  run dev console list
  [ "$status" -eq 0 ]
  [ "$output" = "$RELAY_LIST" ]
  run dev console say hello from the relay
  [ "$status" -eq 0 ]
  # The broadcast reaches the log a moment after the reply; no grep -q, whose
  # early exit would kill docker logs with SIGPIPE.
  timeout 10 bash -c 'until docker logs "$1" 2>&1 | grep "hello from the relay" >/dev/null; do sleep 0.5; done' _ "$SERVER"
  # The client exits after each call; the daemon and its one RCON connection stay.
  [ "$(docker inspect --format '{{.State.Status}} {{.State.StartedAt}}' "$relay")" = "running $started" ]
  [ "$(docker exec "$SERVER" sh -c 'grep -c "RCON Client .* started" /server/logs/latest.log')" -eq 1 ]
  run dev console
  [ "$status" -eq 2 ]
  [[ $output == *"console needs a server command"* ]]
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
  # The relay outlived the server's restart and reconnects on the next call.
  run dev console list
  [ "$status" -eq 0 ]
  [ "$output" = "$RELAY_LIST" ]
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
  ln -s eula.txt "$MC_HOME/server/link"
  git -C "$MC_HOME" add server
  git -C "$MC_HOME" commit -q -m 'committed symlink'
  run dev rebuild
  git -C "$MC_HOME" reset -q --hard HEAD~1
  [ "$status" -eq 2 ]
  [[ $output == *"symlinks refused in server/: server/link"* ]]
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
  [ "$(docker image ls -q --filter "label=mc-harness.project=$PROJECT" --filter reference='mc-dev:*' | sort -u | wc -l)" -eq 1 ]
  [ "$(docker image ls -q --filter "label=mc-harness.project=$PROJECT" --filter reference='mc-relay:*' | sort -u | wc -l)" -eq 1 ]
  # The relay was recreated with the pod.
  run dev console list
  [ "$status" -eq 0 ]
  [ "$output" = "$RELAY_LIST" ]
}

@test "a cached image built at another commit of the same tree reports the commit checked out" {
  built=$(label commit)
  git -C "$MC_HOME" commit -q --allow-empty -m 'docs only'
  run dev rebuild
  [ "$status" -eq 0 ]
  [[ $output == *"image: cache hit"* ]]
  [ "$(docker image inspect --format '{{index .Config.Labels "mc-harness.commit"}}' "$(docker inspect --format '{{.Config.Image}}' "$SERVER")")" = "$built" ]
  [ "$(label commit)" = "$(git -C "$MC_HOME" rev-parse HEAD)" ]
  [ "$(label source)" = archive ]
}

@test "console refuses with exit 2 when the relay is gone" {
  docker rm -f "mc-$PROJECT-dev-relay" >/dev/null
  run dev console list
  [ "$status" -eq 2 ]
  [[ $output == *"relay of pod dev is missing"* ]]
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

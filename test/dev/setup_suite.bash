# Dev tier: one temp project whose committed server/ is vanilla Purpur (primed
# once into ~/.cache/mc-harness/ by ./prime), shared by every test in order.

setup_suite() {
  local primed
  primed=$("$BATS_TEST_DIRNAME/prime")
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 MC_JAVA_OPTS='-Xms256M -Xmx1G'
  export MC_HOME=$BATS_SUITE_TMPDIR/proj FIXTURES=$BATS_SUITE_TMPDIR/fixtures
  export DEV=$BATS_TEST_DIRNAME/../../bin/dev
  git init -q -b main "$MC_HOME"
  PROJECT=$(printf %s "$(realpath "$MC_HOME")" | sha256sum | cut -c1-8)
  export PROJECT SERVER=mc-$PROJECT-dev-server
  git -C "$MC_HOME" config user.name test
  git -C "$MC_HOME" config user.email test@example.com
  mkdir -p "$MC_HOME/server" "$FIXTURES"
  cp -R "$primed"/{purpur.jar,cache,libraries,versions} "$MC_HOME/server/"
  # Accepting the EULA is part of running any Minecraft server; this one only
  # ever runs offline inside the test pod.
  echo eula=true >"$MC_HOME/server/eula.txt"
  cat >"$MC_HOME/server/server.properties" <<'EOF'
online-mode=true
motd=vanilla
level-type=minecraft\:flat
generate-structures=false
view-distance=3
simulation-distance=3
spawn-protection=0
EOF
  # A CRLF YAML whose override keeps its size (true\r -> false): the image
  # must still carry it (bin/dev verifies every override after each build).
  mkdir -p "$MC_HOME/server/config"
  printf 'update-checker:\r\n  enabled: true\r\n' >"$MC_HOME/server/config/paper-global.yml"
  # Bukkit's default throttle refuses a second join from one address within 4s.
  printf 'settings:\n  connection-throttle: 4000\n' >"$MC_HOME/server/bukkit.yml"
  echo 'from fixtures' >"$FIXTURES/fixture.txt"
  git -C "$MC_HOME" add server
  git -C "$MC_HOME" commit -q -m 'vanilla server'
}

teardown_suite() {
  "$DEV" down --all </dev/null || true
  docker image ls -q --filter "label=mc-harness.project=$PROJECT" | xargs -r docker image rm -f >/dev/null || true
}

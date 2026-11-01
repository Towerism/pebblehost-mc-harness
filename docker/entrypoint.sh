#!/bin/sh
# Dev server entrypoint. On the volume's first boot only, copy /fixtures over
# /server and write the marker, so restarts keep server state (bin/dev reset
# deletes the marker). Then write the pod's RCON password, which never enters
# the image, and run the server as PID 1 so docker stop saves the world.
set -eu
cd /server

if [ ! -e .mc-harness-seeded ]; then
  if [ -d /fixtures ]; then cp -R /fixtures/. /server/; fi
  touch .mc-harness-seeded
fi

: "${RCON_PASSWORD:?RCON_PASSWORD is not set}"
: "${MC_JAR:?MC_JAR is not set}"
set_prop() {
  touch server.properties
  awk -v k="$1" -v v="$2" '
    index($0, k "=") == 1 { print k "=" v; found = 1; next }
    { print }
    END { if (!found) print k "=" v }
  ' server.properties >server.properties.tmp
  mv server.properties.tmp server.properties
}
set_prop enable-rcon true
set_prop rcon.port 25575
set_prop rcon.password "$RCON_PASSWORD"
set_prop broadcast-rcon-to-ops false

# shellcheck disable=SC2086 # JAVA_OPTS holds several flags.
exec java $JAVA_OPTS -jar "$MC_JAR" --nogui

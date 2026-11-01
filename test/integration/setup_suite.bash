# One SFTP container serves the whole integration run; tests isolate by subdirectory.

setup_suite() {
  export SFTP_CONTAINER=mc-it-$$ SFTP_UID=1001
  # shellcheck disable=SC2016 # literal $ checks .env values are not expanded
  export SFTP_PASSWORD='it pa$$word'
  docker run -d --rm --name "$SFTP_CONTAINER" -p 127.0.0.1::22 \
    atmoz/sftp:alpine "mc:$SFTP_PASSWORD:$SFTP_UID:$SFTP_UID:upload" >/dev/null
  SFTP_PORT=$(docker port "$SFTP_CONTAINER" 22/tcp | head -1 | sed 's/.*://')
  export SFTP_PORT

  for _ in $(seq 50); do
    docker exec "$SFTP_CONTAINER" sh -c 'pgrep sshd >/dev/null && test -d /home/mc/upload' && \
      (exec 3<>"/dev/tcp/127.0.0.1/$SFTP_PORT") 2>/dev/null && return 0
    sleep 0.2
  done
  echo "sftp container did not start" >&2
  return 1
}

teardown_suite() {
  docker rm -f "$SFTP_CONTAINER" >/dev/null 2>&1 || true
}

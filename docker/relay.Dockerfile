# Relay image: the pod's resident daemon (src/relay/). The context is laid out
# by src/dev/image.ts: relay/ holds the three .ts files and a package.json.
# bin/dev runs it with --init, so Docker's bundled tini is PID 1 and forwards
# signals, read-only, as uid 1000, with only a tmpfs /run for the socket.
FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

COPY relay /relay/
USER 1000:1000
WORKDIR /relay
ENTRYPOINT ["node", "/relay/daemon.ts"]

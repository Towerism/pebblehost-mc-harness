# Relay image: the pod's resident daemon (src/relay/). The context is laid out
# by src/dev/image.ts: deps/ holds docker/relay/package.json and its lockfile
# (mineflayer, exact versions and integrity hashes), relay/ the .ts files and
# a package.json. Only this build stage reaches the npm registry; the pod has
# no network. bin/dev runs it with --init, so Docker's bundled tini is PID 1
# and forwards signals, read-only, as uid 1000, with tmpfs /run and /tmp.
FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS deps
WORKDIR /deps
COPY deps/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
COPY --from=deps /deps/node_modules /relay/node_modules
COPY relay /relay/
USER 1000:1000
WORKDIR /relay
ENTRYPOINT ["node", "/relay/daemon.ts"]

# docker

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The image definitions for the dev tier: the offline server image (`server.Dockerfile`, `entrypoint.sh`) and the pod's relay image (`relay.Dockerfile`, `relay/`). `src/dev/image.ts` lays out each build context and copies these files in; nothing here is built by hand.

## Key Files
| File | Description |
|------|-------------|
| `server.Dockerfile` | Temurin 25 JRE (`eclipse-temurin:25-jre`, pinned by digest). Separate COPY layers: jar layer (`bin/`: jars, `libraries/`, `versions/`, `cache/`), config layer (`cfg/`, the rest of `server/`), overrides layer (`ovr/`), so a config-only commit reuses the jar layer. Runs as 1000:1000, `ENV JAVA_OPTS`, exposes 25565, entrypoint `mc-entrypoint` |
| `entrypoint.sh` | Fixtures on first boot, RCON password, `exec java`. On the volume's first boot only (no `/server/.mc-harness-seeded`) copies `/fixtures` over `/server` and writes the marker; then sets `enable-rcon`, `rcon.port`, `rcon.password` (from `RCON_PASSWORD`) and `broadcast-rcon-to-ops=false` in `server.properties`, and `exec java $JAVA_OPTS -jar "$MC_JAR" --nogui` so the server is PID 1 |
| `relay.Dockerfile` | Node 24 slim (`node:24.21.0-slim`, pinned by digest). A deps stage runs `npm ci --omit=dev --ignore-scripts` on `docker/relay/package.json` and its lockfile; the final stage copies `node_modules` and the `src/relay/` files and runs `node /relay/daemon.ts` as 1000:1000 |
| `relay/package.json`, `relay/package-lock.json` | The relay's one dependency: mineflayer 4.39.0, exact version, with integrity hashes in the lockfile |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `relay/` | `package.json` and `package-lock.json` for the relay image's deps stage. Not a source directory; the relay's code is `src/relay/` |

## For AI Agents

### Working In This Directory
- The first relay build needs the npm registry (only the deps stage reaches it; the pod itself has no network). mineflayer 4.39.0 matches game version `26.1`, which `src/relay/daemon.ts` passes to bots.
- Build contexts are laid out by `src/dev/image.ts`: `bin/`, `cfg/`, `ovr/` for the server image (the Dockerfile copies `bin`, `cfg`, `ovr`, `entrypoint.sh`); `deps/` (this directory's `relay/` files), `relay/` (the `.ts` files and a `package.json` of `{"type":"module"}`) for the relay. Renaming a context directory means editing both sides.
- `server.Dockerfile` and `entrypoint.sh` are in `HARNESS_INPUTS` (with `src/dev/overrides.ts`); the relay Dockerfile and `relay/package*.json` are in `RELAY_INPUTS`. Any edit changes the image hash or relay tag, rebuilds the image, and is refused by `bin/dev up`, `rebuild` and `bin/check run` until committed.
- Keep base images pinned by digest. A change to a digest or to the entrypoint changes every image hash.
- The relay container runs `--init` (Docker's bundled tini is PID 1 and forwards signals), read-only, as uid 1000, with tmpfs `/run` and `/tmp`; `/run/relay.sock` must stay writable there. The server container runs as uid 1000 and `/server` takes its owner from the directory made in the Dockerfile (`install -d -o 1000 -g 1000 /server`). RCON password and `MC_JAR` come at run time from `bin/dev`, never from the image.
- Dev images and `.dev/` hold server configs and their secrets: never push an `mc-dev` image.
- `bin/dev reset` deletes `/server/.mc-harness-seeded` so the next boot applies `/fixtures` again. The entrypoint's `set_prop` rewrites `server.properties` on every boot, so RCON settings survive a pulled file.

### Testing Requirements
`make test-dev` (about a minute; builds both images and boots vanilla Purpur in Docker, needs Docker and, once, network for `test/dev/prime`): `test/dev/dev.bats` is the end-to-end test. `test/ts/dev.test.ts` checks the build context layout (`buildContext`, `buildRelay` inputs, `HARNESS_INPUTS`, `RELAY_INPUTS`) with a fake docker, and `test/ts/guard.test.ts` covers the public allowlist entry for this directory. Run `make lint` too (shellcheck covers `entrypoint.sh`).

### Common Patterns
- Comments at the top of each Dockerfile say what `src/dev/image.ts` puts into the context; keep them true.
- `entrypoint.sh` is POSIX `sh` with `set -eu`; required variables use `: "${VAR:?message}"`.

## Dependencies

### Internal
- `../src/dev/image.ts` (`HARNESS_INPUTS`, `RELAY_INPUTS`, `buildContext`, `buildRelay`), `../src/dev/pod.ts` (run flags, mounts, env), `../src/relay/` (files copied into the relay image), `../src/dev/overrides.ts` (the overrides layer's content)

### External
- Docker; images `eclipse-temurin:25-jre` and `node:24.21.0-slim` (pinned by digest); `npm` registry (relay deps stage, first build only); `mineflayer` 4.39.0

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

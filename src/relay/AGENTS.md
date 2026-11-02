# src/relay

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The pod's relay container: a resident daemon on the pod network that owns the server's RCON connection and the headless bot sessions, so `bin/dev console`, `bin/dev bot` and the check APIs can reach a pod that has no published port.

## Key Files
| File | Description |
|------|-------------|
| `daemon.ts` | PID 1 behind tini. One JSON request, one JSON reply per connection on `/run/relay.sock` (`RELAY_SOCKET` overrides), dispatched by `op` through a table of `Handler`s. Exports `serve`, `handle`, `consoleOps`, `rconSession`. `rconSession` owns the pod's RCON connection, opens it on first use and reconnects after a server restart; a command never runs twice. Env: `RCON_HOST`, `RCON_PASSWORD`, `RCON_PORT` (25575), `GAME_PORT` (25565) |
| `bots.ts` | mineflayer sessions by name (`botOps`): `bot.join` resolves on spawn, `bot.chat`, `bot.waitMessage` reads received lines from a cursor so a reply between two calls isn't lost, `bot.quit`, `bot.quitAll`, `bot.list`. The factory (`CreateBot`) is injected |
| `client.ts` | Stdin request, stdout reply, exit 0 (reply `ok`) or 2; run by `bin/dev console` through `docker exec -i`. `clientTimeout` |
| `rcon.ts` | RCON codec and client: `encode`, `Decoder`, `Rcon` (auth, multi-packet replies via an end-marker packet, timeouts) |
| `mineflayer.d.ts` | The part of mineflayer 4.39.0 the relay uses; mineflayer is installed only in the relay image |

## For AI Agents

### Working In This Directory
- Sessions live only in the daemon: a relay restart or recreate (`bin/dev up`, `rebuild`) drops them, a server restart disconnects them, and they must join again. `restart` and `reset` leave the relay running.
- Timeouts: the client's timeout is a minute past the request's `timeoutMs` (`clientTimeout`, capped at 600s of request time), and the daemon's idle timeout (30s) covers only reading the request, so long waits aren't cut. A request is the first line or everything before the client's EOF, at most 64 KiB; the connection is `allowHalfOpen` so a client that ends its side after writing still gets the reply.
- New relay verbs go into the daemon's `op` table; `consoleOps` is the pattern (a `Record<string, Handler>` spread into the table in the `import.meta.main` block). Handlers throw to reply `{ok:false,error}`; an unknown `op` is refused (`Object.hasOwn`).
- mineflayer is imported dynamically in the daemon: without it (the unit tests run `daemon.ts` on the host) the daemon serves `console` alone. Bots join as `auth: 'offline'` with version `26.1`; names must match `[A-Za-z0-9_]{3,16}`. A session keeps at most 1000 lines (the cursor shifts with the oldest dropped).
- `bot.waitMessage` returns the first line at or after the cursor that matches and moves the cursor past it; flags are limited to `i`, `m`, `s`, `u`; it fails at once when the bot has left. `bot.join` fails on timeout (default 30s), kick, error or end before spawn; `timeoutMs` must be 1..600000.
- RCON: commands run one at a time; a reply the server splits across packets is completed by a trailing packet of type 200 (`MARKER`), which vanilla answers with "Unknown request" under the same id after the earlier replies. A command over 1446 bytes (`MAX_BODY`) is refused. Any socket error, close or timeout marks the connection closed and fails what is pending.
- The files in this directory are baked into the relay image and hashed into its tag through `RELAY_INPUTS` in `../dev/image.ts` (`daemon.ts`, `client.ts`, `rcon.ts`, `bots.ts`). Changing one rebuilds the relay image, and `bin/dev up`, `rebuild` and `bin/check run` then refuse it until it is committed. `mineflayer.d.ts` is types only and not an input. The relay container is read-only, uid 1000, no network beyond the pod's (details in `../dev/AGENTS.md`).
- The socket is mode 0600 inside a tmpfs `/run`. The RCON password comes from the container environment, never argv.

### Testing Requirements
`make test-unit` runs `test/ts/relay.test.ts` (`daemon.ts`, `rcon.ts`, `client.ts` against fakes) and `test/ts/bots.test.ts` (`botOps` with an injected fake bot, dispatched through `handle`). `make test-dev` (`test/dev/dev.bats`) drives the real relay with `bin/dev console` and `bin/dev bot`; `test/ts/live.test.ts` and `test/integration/target-live.bats` cover the check APIs' refusal of console and bots on the live target. After a change run `make test` and `make test-dev`.

### Common Patterns
- Ops are `async (req) => ({...fields})`; validate with small helpers (`str`, `ms`) that name the missing key in the error.
- Everything with I/O takes its collaborator as an argument (`CreateBot`, `RconSession`) so tests inject fakes.

## Dependencies

### Internal
- `../dev/image.ts` (`RELAY_INPUTS`, `buildRelay` build the image), `../dev/pod.ts` (`createPod` starts the container, `relayRequest` runs `client.ts` through `docker exec -i`)
- `../../docker/relay.Dockerfile` and `../../docker/relay/` (dependencies)
- Callers: `../check/` (`dev.ts`, `bot.ts`)

### External
- Node 24 (runs the `.ts` files directly), `mineflayer` 4.39.0 (relay image only), `node:net`

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.

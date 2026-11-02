# dev

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
The dev tier: `bin/dev` and `bin/check` against Docker and a vanilla Purpur 26.1.2 server. The tests boot real pods, so this tier is the slowest and is not part of `make test`.

## Key Files
| File | Description |
|------|-------------|
| `prime` | Downloads Purpur 26.1.2 build 2592 once into `${XDG_CACHE_HOME:-~/.cache}/mc-harness/purpur-26.1.2-2592/` (MD5 and SHA-256 checked), runs paperclip in `eclipse-temurin:25-jre` so it fetches and patches `cache/`, `libraries/` and `versions/`, touches `.primed`, and prints the directory. The only step of the tier that needs network, and only on the first run |
| `setup_suite.bash` | Makes a temp project (`MC_HOME`) whose committed `server/` is the primed tree plus `eula.txt`, a flat-world `server.properties`, a CRLF `config/paper-global.yml` (to prove a size-preserving override still lands) and a `bukkit.yml` with a 4 s connection throttle. Exports `DEV`, `PROJECT`, `SERVER` and `FIXTURES`. `teardown_suite` runs `bin/dev down --all` and removes the project's images |
| `dev.bats` | `bin/dev` lifecycle on one shared pod, in file order: `up` refusing uncommitted `server/`, a boot to `Done` with fixtures and overrides applied, no default route, egress, DNS or listener on 8192 (via `egress-probe`, for the server and the relay), `console` returning the exact RCON reply over a reused relay connection, a bot that chats across CLI calls, `status` and `boot-report`, `restart` keeping files and SQLite rows, `reset`, `rebuild` (refusing a dirty tree, a failed build leaving the old pod, a config-only commit reusing the jar layer, a cached image reporting the checked-out commit), `console` exit 2 without a relay, and `join` through a locked-down proxy container plus `down --all` |
| `seed.bats` | `bin/dev seed 7` end to end. Its own `atmoz/sftp` container serves the primed Purpur tree as live: seed syncs it to `main`, cuts `issue/7` and boots a pod with the opt-in data as fixtures. A re-seed keeps the issue commits and leaves nothing of the old pod or data |
| `suite.bats` | `bin/check suite` twice over three profiles (no fixtures, with an undeclared `dev.restart()` that fails; fixtures restored by copy, with a declared restart; vanilla IP bans as declared data, reset by a restart) plus a bare-text check: same results both times, image cached the second time, one boot and teardown per profile, nothing left over. Then SIGINT and SIGTERM mid-boot exit 130 and 143 with every suite pod removed |
| `verify.bats` | The `bin/check run` and gate loop, after `suite.bats`: a red on a fresh volume, the explored marker surviving a deleted `.dev/`, a hand-made green refused (G3), a no-op commit plus a console repair refused (G9, explored), another check repairing the server before the green refused (G9, not first on the volume), two parallel runs getting positions 0 and 1 with the overlap flagged, uncommitted records refused (G10), a green only after a fix commit and `rebuild`, the gate with its confirm run, postmortem and runbook, and an explored red refused (G9) |
| `egress-probe` | Runs inside a pod container, not on the host: prints one line per isolation check (IPv4 and IPv6 default routes, TCP to 1.1.1.1:443, DNS for example.com, a listener on port 8192) and exits non-zero if any way out exists. Called by `dev.bats` |
| `budget.json` | Boot-time baseline: the vanilla server's first-boot and restart times plus a measurement of the live copy, measured 2026-11-01. Data for `bin/check suite`'s `OVER BUDGET` report, not a test |

## For AI Agents

### Working In This Directory
- The tests share one pod and depend on file order: `dev.bats`, then `suite.bats`, then `verify.bats` (bats runs files alphabetically; `seed.bats` sits between and builds its own project and container). Each test states what it expects from the ones before it. Do not run a single test in isolation unless the earlier state exists.
- Every `bin/dev` call closes stdin and runs under `timeout` (300 s, 600 s in `seed.bats`).
- `egress-probe` and `prime` are shellchecked by `make lint`; keep them shellcheck-clean.
- Pods and images are labelled per project. If a run is killed, `bin/dev down --all` removes what it left.

### Testing Requirements
`make test-dev` (`bats --print-output-on-failure test/dev`), about a minute once primed. Needs Docker. The first run needs network once for `prime`; later runs boot offline from `~/.cache/mc-harness/`. The suite's own check of `budget.json` is `OVER BUDGET` in the suite output; when the baseline changes, re-measure and update the file.

### Common Patterns
- Tests run `$DEV` (the repo's `bin/dev`) against `$MC_HOME`, a temp project with `GIT_CONFIG_GLOBAL=/dev/null` and a throwaway committer.
- Fixtures and servers are built at run time from the primed cache; nothing is committed under `test/` (the path guard refuses `server/`, `plugins/` and `*.jar`).
- `MC_JAVA_OPTS='-Xms256M -Xmx1G'` keeps the vanilla pod small.

## Dependencies
- Docker, `git`, `curl`, `md5sum`, `sha256sum`, bats >= 1.5.0.
- `bin/dev`, `bin/check`, `bin/mc` and `docker/` of this repo.
- Images `eclipse-temurin:25-jre` (digest pinned in `prime`) and `atmoz/sftp:alpine` (`seed.bats`).
- Network on the first `prime` only (api.purpurmc.org).

## Manual Notes
Notes under this heading are written by humans and preserved on regeneration.

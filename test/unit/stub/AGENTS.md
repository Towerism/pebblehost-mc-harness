# stub

**Parent context:** `../AGENTS.md`
**Generated:** 2026-11-01 · **Updated:** 2026-11-01

## Purpose
A fake `rclone` for the unit tests. It records calls and never touches the network.

## Key Files
| File | Description |
|------|-------------|
| `rclone` | Appends argv to `$STUB_LOG`, writes `RCLONE_CONFIG_PEBBLE_*` to `$STUB_ENV`. `obscure` saves stdin to `$STUB_OBSCURED` and prints `OBSCURED`; `lsf` prints `$STUB_LSF`; `copyto` from `pebble:` writes the word `remote` to the destination |

## For AI Agents

### Working In This Directory
When `bin/mc` starts using a new rclone subcommand or flag, extend the stub just enough for the unit tests to observe it. Behaviour that depends on real SFTP belongs in `../../integration/`.

## Manual Notes

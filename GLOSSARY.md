---
documentLanguage: en
---

# Glossary

One entry per term: definition, boundaries, one resolved ambiguity. Agents write here the moment a term is settled. Vocabulary here is law for all specs, tickets, and code naming. Ship-specific terms only: a concept any sea chart carries does not get an entry. Behavior (commands, flags, rules) lives in `CLAUDE.md`; entries here define words and point there.

## live
- Definition: the real server on PebbleHost, reached only over SFTP through `bin/mc`.
- Boundary: is the hosted server; not the local mirror `server/`, and not a dev pod.
- Avoid: "prod", "remote server" (when the dev pod is also in play).
- Resolved ambiguity: `--target live` reads live read-only; writes to live go through `bin/mc push` (public harness) or `bin/check runbook push N` (private repo).

## pod
- Definition: the local dev server `bin/dev` boots in Docker from committed `server/`: a server container plus its relay container, on a network with no egress.
- Boundary: is a disposable local copy; not live.
- Avoid: "dev env", "container" (a pod is two containers and a volume).
- Resolved ambiguity: `restart` keeps the pod's volume; `rebuild` and `--fresh` give it a new one.

## check
- Definition: a committed directory `checks/<id>/` holding `profile.json` and `*.test.ts`, run by `bin/check run`.
- Boundary: is a recorded verification of one issue's fix; not the harness's own test suites under `test/`.
- Avoid: "test" for a check as a whole.
- Resolved ambiguity: kind `e2e` runs against a pod; kind `bare-text` reads committed `server/` files and needs no pod.

## red / green / confirm
- Definition: run records of one check: a red failed before the fix, a green passed after it, a confirm is the gate's re-run of the green.
- Boundary: only records that satisfy gate rules G1-G10 (`CLAUDE.md`, `bin/check`) count; a live run never counts.
- Avoid: "pass/fail" when the record's role in the gate is meant.
- Resolved ambiguity: the latest confirm of the chosen green decides the gate.

## forward issue
- Definition: a server issue taken through the loop in order: a red run before the fix, then a green, a confirmed gate pass, and `bin/check runbook push N` (private repo) putting the fix on live.
- Boundary: is what the gate-rule freeze (`CLAUDE.md`, #30) counts; not an issue whose check was written after the fix was already on live, nor a fix pushed with a bare `bin/mc push`.
- Avoid: "real issue" when the order of red and fix is what matters.
- Resolved ambiguity: an issue whose fix reached live before its red does not count, even if it later gets a gate pass.

## explored
- Definition: a pod volume touched by `bin/dev console`, `bot` (except `list`) or `join`, marked by `/server/.mc-harness-explored` inside the volume.
- Boundary: is a property of the volume; survives `restart` and `reset`, cleared only by a new volume.
- Resolved ambiguity: a check's own `dev.console` calls do not mark the volume.

## private repo
- Definition: a server-specific repo started from `template/`, marked by `.harness-private`, holding this harness as its `harness/` submodule.
- Boundary: is where live's files are committed (`main` mirrors live); this public repo never holds server files.
- Avoid: "server repo" without saying private.
- Resolved ambiguity: in a private repo a bare `bin/mc push` is refused; live writes go through `bin/check runbook push N`.

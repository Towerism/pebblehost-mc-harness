// The read-only live target (MC_TARGET=live): files, the log and databases
// come from the live server through `bin/mc pull` into the run's own MC_HOME
// (MC_LIVE_HOME), with MC_ENV_FILE naming the project's .env, which only
// bin/mc reads. The console, restarts and bots are refused: a check that
// declares the need in profile.json (MC_NEEDS) has that test skipped, any
// other check fails.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HARNESS_ROOT } from '../dev/image.ts';

// In a skipped test's error; bin/check run counts such a test as skipped.
export const LIVE_SKIP = 'MC_LIVE_SKIP';
// In a test's error when a database kept changing while it was pulled:
// bin/check run refuses the run (exit 2) and records nothing.
export const LIVE_CHANGED = 'live database changed during pull';

export class LiveReadOnlyError extends Error {}

export const onLive = () => process.env.MC_TARGET === 'live';

// need 'restart': declared by "restart" or "exclusive" in profile.json (as
// MC_RESTART_OK) or by needing the console.
export function refuseOnLive(what: string, need: 'console' | 'bot' | 'restart'): never {
  const needs = (process.env.MC_NEEDS ?? '').split(',');
  const declared = need === 'restart' ? process.env.MC_RESTART_OK === '1' || needs.includes('console') : needs.includes(need);
  if (declared) throw new LiveReadOnlyError(`${LIVE_SKIP} ${what} needs the ${need}, which the live target doesn't have: skipped`);
  throw new LiveReadOnlyError(`${what} is not available on the live target, and the check's profile.json doesn't declare ${need === 'restart' ? '"restart": true' : `"needs": ["${need}"]`}`);
}

function mc(args: string[]): string {
  const home = process.env.MC_LIVE_HOME;
  if (!home || !process.env.MC_ENV_FILE) throw new Error('MC_LIVE_HOME or MC_ENV_FILE is not set: run checks with bin/check run --target live');
  const r = spawnSync(join(HARNESS_ROOT, 'bin/mc'), args, { encoding: 'utf8', env: { ...process.env, MC_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`bin/mc ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// One level of a live directory (bin/mc ls -l): name -> "size modtime", a
// directory's name ending in /.
export function liveList(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of mc(['ls', '-l', ...(dir ? [dir] : [])]).split('\n')) {
    const m = /^\s*(\S+)  (\S+ \S+)  (.+)$/.exec(line);
    if (m) out.set(m[3], `${m[1]} ${m[2]}`);
  }
  return out;
}

export const splitPath = (path: string) => ({ dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', name: path.slice(path.lastIndexOf('/') + 1) });

// Pull one regular file from live into the run's home and return the local
// copy's path. A directory would pull everything under it, so the parent is
// listed first and anything but a file there is refused. bin/mc refuses
// absolute paths and `..`.
export function livePull(path: string): string {
  if (path.split('/').some((s) => s === '' || s === '.')) throw new Error(`${path || '(empty)'}: a live read takes a file path (no trailing /, no empty or . segment), not a directory`);
  const { dir, name } = splitPath(path);
  const there = liveList(dir);
  if (there.has(`${name}/`)) throw new Error(`${path} is a directory on live; a live read pulls single files only`);
  if (!there.has(name)) throw new Error(`${path} not found on live`);
  mc(['pull', path]);
  return join(process.env.MC_LIVE_HOME as string, 'server', path);
}

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

export class LiveReadOnlyError extends Error {}

export const onLive = () => process.env.MC_TARGET === 'live';

export function refuseOnLive(what: string, need: 'console' | 'bot'): never {
  const needs = (process.env.MC_NEEDS ?? '').split(',');
  if (needs.includes(need)) throw new LiveReadOnlyError(`${LIVE_SKIP} ${what} needs the ${need}, which the live target doesn't have: skipped`);
  throw new LiveReadOnlyError(`${what} is not available on the live target, and the check's profile.json doesn't declare "needs": ["${need}"]`);
}

// Pull one server path from live into the run's home and return the local
// copy's path. bin/mc refuses absolute paths and `..`.
export function livePull(path: string): string {
  const home = process.env.MC_LIVE_HOME;
  if (!home || !process.env.MC_ENV_FILE) throw new Error('MC_LIVE_HOME or MC_ENV_FILE is not set: run checks with bin/check run --target live');
  const r = spawnSync(join(HARNESS_ROOT, 'bin/mc'), ['pull', path], { encoding: 'utf8', env: { ...process.env, MC_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`bin/mc pull ${path} failed: ${(r.stderr || r.stdout).trim()}`);
  return join(home, 'server', path);
}

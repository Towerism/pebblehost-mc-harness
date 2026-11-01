// Harness API for e2e checks, imported as '#harness/dev'. It talks to the pod
// that bin/check run names in MC_POD under MC_HOME; console calls go through
// the pod's relay and do not mark the volume explored. On the live target
// (bin/check run --target live) file, log and database reads come from the
// live server over SFTP, and the console and restarts are refused (live.ts).
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { docker as d, must } from '../dev/docker.ts';
import { names, podOf, relayRequest, restartServer } from '../dev/pod.ts';
import { LIVE_CHANGED, liveList, livePull, onLive, refuseOnLive, splitPath } from './live.ts';

function pod() {
  if (process.env.MC_TARGET !== undefined && process.env.MC_TARGET !== 'dev') throw new Error(`target ${process.env.MC_TARGET} has no pod`);
  if (!process.env.MC_HOME) throw new Error('MC_HOME is not set: run checks with bin/check run');
  return podOf(process.env.MC_HOME, process.env.MC_POD || 'dev');
}

// A path under the server root: relative, no `..`.
function serverPath(path: string): string {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`bad server path ${path}: use one relative to the server root`);
  return `/server/${path}`;
}

export type Row = Record<string, unknown>;

// Only a check whose profile declares restart or exclusive may restart its
// pod: the suite schedules those last on a shared pod, or alone.
function restart(reset: boolean): void {
  if (onLive()) refuseOnLive(`dev.${reset ? 'reset' : 'restart'}()`, 'restart');
  if (process.env.MC_RESTART_OK !== '1') throw new Error(`dev.${reset ? 'reset' : 'restart'}() needs "restart": true or "exclusive": true in the check's profile.json`);
  restartServer(pod(), d, reset);
}

export const dev = {
  // Restart the server on the same volume (state kept) and wait for "Done".
  async restart(): Promise<void> {
    restart(false);
  },
  // Restart and apply the fixtures again (bin/dev reset).
  async reset(): Promise<void> {
    restart(true);
  },
  // The exact RCON reply.
  async console(command: string): Promise<string> {
    if (onLive()) refuseOnLive('dev.console()', 'console');
    return String(relayRequest(pod(), d, { op: 'console', command }).reply);
  },
  // Server console output since `since` (a Date or epoch milliseconds). On
  // live: the whole current logs/latest.log (its lines carry no date).
  async logSince(since: Date | number): Promise<string> {
    if (onLive()) return readFileSync(livePull('logs/latest.log'), 'utf8');
    const ms = typeof since === 'number' ? since : since.getTime();
    const r = d(['logs', '--since', (ms / 1000).toFixed(3), names(pod()).server]);
    if (r.status !== 0) throw new Error(`docker logs failed: ${r.stderr.trim()}`);
    return r.stdout + r.stderr;
  },
  async file(path: string): Promise<string> {
    if (onLive()) return readFileSync(livePull(serverPath(path).slice('/server/'.length)), 'utf8');
    return must(d, ['exec', names(pod()).server, 'cat', serverPath(path)]);
  },
  // Rows of a read-only query on a copy of the database, taken with its -wal
  // and -shm so uncheckpointed writes are included.
  async sqlite(path: string, sql: string, ...params: (string | number | null)[]): Promise<Row[]> {
    const tmp = mkdtempSync(join(tmpdir(), 'check-sqlite-'));
    try {
      const db = join(tmp, basename(path));
      if (onLive()) {
        // The db, -wal and -shm come in three pulls; a plugin writing in
        // between would pair mismatched files. Their listing must be the
        // same before and after; one retry, then the run is refused.
        const rel = serverPath(path).slice('/server/'.length);
        const { dir, name } = splitPath(rel);
        const state = () => {
          const l = liveList(dir);
          return ['', '-wal', '-shm'].map((ext) => l.get(`${name}${ext}`) ?? 'absent');
        };
        for (let attempt = 1; ; attempt++) {
          const before = state();
          copyFileSync(livePull(rel), db);
          for (const [i, ext] of ['-wal', '-shm'].entries()) {
            rmSync(`${db}${ext}`, { force: true });
            // Usually absent on live once the plugin checkpointed.
            if (before[i + 1] !== 'absent') copyFileSync(livePull(`${rel}${ext}`), `${db}${ext}`);
          }
          if (JSON.stringify(state()) === JSON.stringify(before)) break;
          if (attempt === 2) throw new Error(`${LIVE_CHANGED}: ${rel} (with its -wal and -shm) changed during both pulls; run the check again when the server is quieter`);
        }
      } else {
        const server = names(pod()).server;
        must(d, ['cp', `${server}:${serverPath(path)}`, db]);
        for (const ext of ['-wal', '-shm']) d(['cp', `${server}:${serverPath(path)}${ext}`, `${db}${ext}`]);
      }
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        return conn.prepare(sql).all(...params).map((row) => ({ ...row }));
      } finally {
        conn.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};

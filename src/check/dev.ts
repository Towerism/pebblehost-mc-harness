// Harness API for e2e checks, imported as '#harness/dev'. It talks to the pod
// that bin/check run names in MC_POD under MC_HOME; console calls go through
// the pod's relay and do not mark the volume explored.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { docker as d, must } from '../dev/docker.ts';
import { names, podOf, relayRequest } from '../dev/pod.ts';

function pod() {
  if (process.env.MC_TARGET !== undefined && process.env.MC_TARGET !== 'dev') throw new Error(`target ${process.env.MC_TARGET} is not supported`);
  if (!process.env.MC_HOME) throw new Error('MC_HOME is not set: run checks with bin/check run');
  return podOf(process.env.MC_HOME, process.env.MC_POD || 'dev');
}

// A path under the server root: relative, no `..`.
function serverPath(path: string): string {
  if (path.startsWith('/') || path.split('/').includes('..')) throw new Error(`bad server path ${path}: use one relative to the server root`);
  return `/server/${path}`;
}

export type Row = Record<string, unknown>;

export const dev = {
  // The exact RCON reply.
  async console(command: string): Promise<string> {
    return String(relayRequest(pod(), d, { op: 'console', command }).reply);
  },
  // Server console output since `since` (a Date or epoch milliseconds).
  async logSince(since: Date | number): Promise<string> {
    const ms = typeof since === 'number' ? since : since.getTime();
    const r = d(['logs', '--since', (ms / 1000).toFixed(3), names(pod()).server]);
    if (r.status !== 0) throw new Error(`docker logs failed: ${r.stderr.trim()}`);
    return r.stdout + r.stderr;
  },
  async file(path: string): Promise<string> {
    return must(d, ['exec', names(pod()).server, 'cat', serverPath(path)]);
  },
  // Rows of a read-only query on a copy of the database, taken with its -wal
  // and -shm so uncheckpointed writes are included.
  async sqlite(path: string, sql: string, ...params: (string | number | null)[]): Promise<Row[]> {
    const server = names(pod()).server;
    const tmp = mkdtempSync(join(tmpdir(), 'check-sqlite-'));
    try {
      const db = join(tmp, basename(path));
      must(d, ['cp', `${server}:${serverPath(path)}`, db]);
      for (const ext of ['-wal', '-shm']) d(['cp', `${server}:${serverPath(path)}${ext}`, `${db}${ext}`]);
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

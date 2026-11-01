// checks/<id>/profile.json: what a check needs from the server.
//   kind       "e2e" or "bare-text"
//   fixtures   directories under checks/<id>/ laid over the server tree on
//              the volume's first boot (bin/dev --fixtures)
//   data       fixture paths that are plugin data (reset by a restart, not a
//              copy); *.db and *.sqlite files always are
//   needs      "console" and/or "bot": what the check talks to
//   restart    the check calls dev.restart() or dev.reset()
//   exclusive  the check gets a pod of its own
//   sqlite     server database paths mapped to SQL files in the check; each
//              is built into a new database in the merged fixtures
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from '../dev/docker.ts';
import type { Kind } from './record.ts';

export type Need = 'console' | 'bot';
export type Profile = { kind: Kind; fixtures: string[]; data: string[]; needs: Need[]; restart: boolean; exclusive: boolean; sqlite: Record<string, string> };

const KEYS = ['kind', 'fixtures', 'data', 'needs', 'restart', 'exclusive', 'sqlite'];
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const relative = (s: string) => s !== '' && !s.startsWith('/') && !s.split('/').includes('..');

export function readProfile(root: string, id: string): Profile {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) fail(`bad check id ${id}`);
  const f = join(root, 'checks', id, 'profile.json');
  if (!existsSync(f)) fail(`no checks/${id}/profile.json`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    fail(`checks/${id}/profile.json is not JSON`);
  }
  const bad = (why: string): never => fail(`checks/${id}/profile.json: ${why}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('not an object');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) bad(`unknown key ${k}`);
  const p: Profile = { kind: raw.kind as Kind, fixtures: (raw.fixtures ?? []) as string[], data: (raw.data ?? []) as string[], needs: (raw.needs ?? []) as Need[], restart: (raw.restart ?? false) as boolean, exclusive: (raw.exclusive ?? false) as boolean, sqlite: (raw.sqlite ?? {}) as Record<string, string> };
  if (p.kind !== 'e2e' && p.kind !== 'bare-text') bad('kind must be "e2e" or "bare-text"');
  if (!strings(p.fixtures) || !p.fixtures.every(relative)) bad('fixtures must be directories relative to the check');
  if (!strings(p.data) || !p.data.every(relative)) bad('data must be paths relative to the server root');
  if (!strings(p.needs) || !p.needs.every((n) => n === 'console' || n === 'bot')) bad('needs may hold only "console" and "bot"');
  if (typeof p.restart !== 'boolean' || typeof p.exclusive !== 'boolean') bad('restart and exclusive must be true or false');
  if (typeof p.sqlite !== 'object' || p.sqlite === null || Array.isArray(p.sqlite) || !Object.values(p.sqlite).every((v) => typeof v === 'string')) bad('sqlite must map database paths to SQL files');
  for (const [k, v] of Object.entries(p.sqlite)) {
    if (!relative(k) || !/\.(db|sqlite3?)$/i.test(k)) bad(`sqlite key ${k} must be a server path relative to the root ending .db, .sqlite or .sqlite3`);
    if (!relative(v)) bad(`sqlite value ${v} must be a path relative to the check`);
  }
  if (p.kind === 'bare-text' && (p.fixtures.length || p.data.length || p.needs.length || p.restart || p.exclusive || Object.keys(p.sqlite).length)) bad('a bare-text check takes no fixtures, data, needs, restart, exclusive or sqlite');
  return p;
}

// The check's fixture directories, absolute.
export function fixtureDirs(root: string, id: string, p: Profile): string[] {
  return p.fixtures.map((f) => {
    const dir = join(root, 'checks', id, f);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`checks/${id}/profile.json: fixtures ${f} is not a directory in the check`);
    return dir;
  });
}

// The check's sqlite fixtures: server path -> absolute SQL file.
export function sqliteFixtures(root: string, id: string, p: Profile): Record<string, string> {
  return Object.fromEntries(Object.entries(p.sqlite).map(([target, f]) => {
    const file = join(root, 'checks', id, f);
    if (!existsSync(file) || !statSync(file).isFile()) fail(`checks/${id}/profile.json: sqlite ${f} is not a file in the check`);
    return [target, file];
  }));
}

// Whether a fixture file (relative to the server root) is plugin data.
export function isData(rel: string, p: Profile): boolean {
  return /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(rel) || p.data.some((d) => rel === d || rel.startsWith(`${d.replace(/\/$/, '')}/`));
}
